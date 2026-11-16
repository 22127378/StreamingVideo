import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  generateUploadPresignedUrl,
  checkFileExistsOnS3,
  deleteS3Prefix,
} from '../services/s3Service.js';
import {
  createVideoRecord,
  updateVideoStatus,
  getVideoById,
  listVideos as queryVideos,
  deleteVideoRecord,
  VIDEO_ENTITY_TYPE,
} from '../services/dynamoService.js';
import { sendTranscodeJob } from '../services/sqsService.js';
import { config } from '../config/aws.js';

// Schemas validation
const RequestUploadUrlSchema = z.object({
  fileName: z.string().min(1, 'Tên file không được để trống'),
  contentType: z
    .string()
    .regex(/^video\//, 'ContentType phải là định dạng video (ví dụ: video/mp4, video/quicktime)'),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(config.maxUploadBytes, `File vượt quá giới hạn ${config.maxUploadBytes} bytes`),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  tier: z.enum(['free', 'premium']).default('free'),
});

const CompleteUploadSchema = z.object({
  videoId: z.string().uuid('VideoId không hợp lệ'),
});

const VIDEO_STATUSES = ['UPLOADING', 'PROCESSING', 'READY', 'FAILED'];

const ListVideosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(VIDEO_STATUSES).optional(),
  nextToken: z.string().max(1024).optional(),
});

// Khóa phân trang của GSI: chỉ chấp nhận đúng 3 trường, tránh client chèn khóa tùy ý
const CursorSchema = z
  .object({
    videoId: z.string().min(1).max(64),
    entityType: z.literal(VIDEO_ENTITY_TYPE),
    createdAt: z.string().datetime(),
  })
  .strict();

const VideoIdParamSchema = z.object({
  id: z.string().uuid('VideoId không hợp lệ'),
});

export function encodeCursor(lastKey) {
  return lastKey ? Buffer.from(JSON.stringify(lastKey)).toString('base64url') : null;
}

export function decodeCursor(token) {
  if (!token) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success) {
    const error = new Error('nextToken không hợp lệ');
    error.status = 400;
    throw error;
  }
  return result.data;
}

/**
 * Dữ liệu video trả cho client: bỏ trường nội bộ, thêm URL phát khi video đã READY
 */
export function toPublicVideo(video) {
  const { entityType, ...rest } = video;
  const ready = video.status === 'READY';
  return {
    ...rest,
    streamingUrl: ready ? `${config.cdnBaseUrl}/${video.videoId}/master.m3u8` : null,
    thumbnailUrl: ready ? video.thumbnailUrl || `${config.cdnBaseUrl}/${video.videoId}/thumbnail.jpg` : null,
  };
}

/**
 * [POST /api/videos/upload-url]
 * Sinh S3 Presigned URL để client upload trực tiếp
 */
export async function requestUploadUrl(req, res, next) {
  try {
    const validatedData = RequestUploadUrlSchema.parse(req.body);
    const videoId = uuidv4();

    // 1. Sinh Presigned PUT URL từ S3
    const { uploadUrl, s3Key, bucket, expiresIn, requiredHeaders } = await generateUploadPresignedUrl(
      validatedData.fileName,
      validatedData.contentType,
      videoId,
      validatedData.fileSize
    );

    // 2. Tạo record UPLOADING trong DynamoDB
    const videoRecord = await createVideoRecord({
      videoId,
      title: validatedData.title || validatedData.fileName.replace(/\.[^/.]+$/, ''),
      description: validatedData.description || '',
      originalFileName: validatedData.fileName,
      contentType: validatedData.contentType,
      fileSize: validatedData.fileSize,
      tier: validatedData.tier,
      rawS3Key: s3Key,
    });

    res.status(201).json({
      success: true,
      message: 'Presigned upload URL generated successfully',
      data: {
        videoId,
        uploadUrl,
        // PUT phải gửi đúng các header này, sai kích thước hoặc kiểu file thì S3 trả 403
        uploadHeaders: requiredHeaders,
        s3Key,
        bucket,
        expiresInSeconds: expiresIn,
        video: videoRecord,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * [POST /api/videos/complete]
 * Xác nhận client đã upload xong -> Đổi trạng thái sang PROCESSING -> Đẩy job vào SQS
 */
export async function completeUpload(req, res, next) {
  try {
    const { videoId } = CompleteUploadSchema.parse(req.body);

    // 1. Kiểm tra video tồn tại
    const video = await getVideoById(videoId);
    if (!video) {
      return res.status(404).json({
        success: false,
        message: `Không tìm thấy video với ID: ${videoId}`,
      });
    }

    // 2. Chỉ cho phép hoàn tất khi video đang ở trạng thái UPLOADING (chống gọi lặp)
    if (video.status !== 'UPLOADING') {
      return res.status(409).json({
        success: false,
        message: `Video đã ở trạng thái ${video.status}, không thể xác nhận upload lại`,
        currentStatus: video.status,
      });
    }

    // 3. Xác nhận file gốc thực sự đã nằm trên S3
    const fileCheck = await checkFileExistsOnS3(video.rawBucket, video.rawS3Key);
    if (fileCheck.error) {
      return res.status(502).json({
        success: false,
        message: 'Không kiểm tra được file trên S3. Vui lòng thử lại sau.',
        error: fileCheck.error,
      });
    }
    if (!fileCheck.exists) {
      return res.status(400).json({
        success: false,
        message: 'File video chưa được upload lên S3. Hãy PUT file vào uploadUrl trước khi gọi /complete.',
        s3Key: video.rawS3Key,
      });
    }

    // 4. Cập nhật PROCESSING có điều kiện: nếu 2 request đến cùng lúc thì chỉ 1 request thắng
    //    (request thua nhận ConditionalCheckFailedException -> 409 qua errorHandler)
    const updatedVideo = await updateVideoStatus(
      videoId,
      'PROCESSING',
      { fileSize: fileCheck.contentLength },
      { expectedStatus: 'UPLOADING' }
    );

    // 5. Gửi job vào SQS Queue cho FFmpeg Worker
    let sqsResult;
    try {
      sqsResult = await sendTranscodeJob({
        videoId: video.videoId,
        title: video.title,
        rawBucket: video.rawBucket,
        rawS3Key: video.rawS3Key,
        processedBucket: video.processedBucket,
        targetResolutions: ['1080p', '720p', '480p', '360p'],
      });
    } catch (sqsError) {
      // Trả về UPLOADING để client có thể gọi /complete lại, tránh video kẹt ở PROCESSING
      await updateVideoStatus(videoId, 'UPLOADING', {}, { expectedStatus: 'PROCESSING' }).catch((e) =>
        console.error(`[completeUpload] Không rollback được status của ${videoId}:`, e.message)
      );
      throw sqsError;
    }

    res.status(200).json({
      success: true,
      message: 'Upload confirmed and transcode job queued successfully',
      data: {
        video: updatedVideo,
        sqsMessageId: sqsResult.messageId,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * [GET /api/videos?limit=20&status=READY&nextToken=...]
 * Lấy danh sách video, mới nhất trước, có phân trang
 */
export async function listVideos(req, res, next) {
  try {
    const { limit, status, nextToken } = ListVideosQuerySchema.parse(req.query);
    const { items, lastKey } = await queryVideos({
      limit,
      status,
      startKey: decodeCursor(nextToken),
    });

    res.status(200).json({
      success: true,
      count: items.length,
      nextToken: encodeCursor(lastKey),
      data: items.map(toPublicVideo),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * [GET /api/videos/:id]
 * Lấy chi tiết 1 video
 */
export async function getVideo(req, res, next) {
  try {
    const { id } = VideoIdParamSchema.parse(req.params);
    const video = await getVideoById(id);

    if (!video) {
      return res.status(404).json({
        success: false,
        message: `Video not found with ID: ${id}`,
      });
    }

    res.status(200).json({
      success: true,
      data: toPublicVideo(video),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * [DELETE /api/videos/:id]
 * Xóa video cùng toàn bộ file gốc và file HLS trên S3.
 * Không cho xóa khi đang PROCESSING (worker có thể đang ghi file).
 */
export async function deleteVideo(req, res, next) {
  try {
    const { id } = VideoIdParamSchema.parse(req.params);
    const existing = await getVideoById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: `Video not found with ID: ${id}`,
      });
    }
    if (existing.status === 'PROCESSING') {
      return res.status(409).json({
        success: false,
        message: 'Video đang được transcode, hãy xóa sau khi xử lý xong',
        currentStatus: existing.status,
      });
    }

    // 1. Đánh dấu DELETING có điều kiện: chặn /complete và worker chen vào trong lúc xóa file.
    //    Nếu bước 2 lỗi, bản ghi vẫn ở DELETING và client có thể gọi DELETE lại.
    await updateVideoStatus(id, 'DELETING', {}, { notStatus: 'PROCESSING' });

    // 2. Xóa file gốc và file HLS
    // Prefix cố định theo cách s3Service sinh key (raw/{videoId}/source.ext), không suy từ dữ liệu
    const [rawDeleted, processedDeleted] = await Promise.all([
      deleteS3Prefix(existing.rawBucket || config.rawBucket, `raw/${id}/`),
      deleteS3Prefix(existing.processedBucket || config.processedBucket, `${id}/`),
    ]);

    // 3. Xóa bản ghi
    await deleteVideoRecord(id);

    res.status(200).json({
      success: true,
      message: `Video ${id} deleted successfully`,
      data: { deletedObjects: rawDeleted + processedDeleted },
    });
  } catch (error) {
    next(error);
  }
}
