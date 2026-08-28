import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { generateUploadPresignedUrl } from '../services/s3Service.js';
import {
  createVideoRecord,
  updateVideoStatus,
  getVideoById,
  getAllVideos,
  deleteVideoRecord,
} from '../services/dynamoService.js';
import { sendTranscodeJob } from '../services/sqsService.js';
import { config } from '../config/aws.js';

// Schemas validation
const RequestUploadUrlSchema = z.object({
  fileName: z.string().min(1, 'Tên file không được để trống'),
  contentType: z
    .string()
    .regex(/^video\//, 'ContentType phải là định dạng video (ví dụ: video/mp4, video/quicktime)'),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  tier: z.enum(['free', 'premium']).default('free'),
});

const CompleteUploadSchema = z.object({
  videoId: z.string().uuid('VideoId không hợp lệ'),
});

/**
 * [POST /api/videos/upload-url]
 * Sinh S3 Presigned URL để client upload trực tiếp
 */
export async function requestUploadUrl(req, res, next) {
  try {
    const validatedData = RequestUploadUrlSchema.parse(req.body);
    const videoId = uuidv4();

    // 1. Sinh Presigned PUT URL từ S3
    const { uploadUrl, s3Key, bucket, expiresIn } = await generateUploadPresignedUrl(
      validatedData.fileName,
      validatedData.contentType,
      videoId
    );

    // 2. Tạo record UPLOADING trong DynamoDB
    const videoRecord = await createVideoRecord({
      videoId,
      title: validatedData.title || validatedData.fileName.replace(/\.[^/.]+$/, ''),
      description: validatedData.description || '',
      originalFileName: validatedData.fileName,
      contentType: validatedData.contentType,
      tier: validatedData.tier,
      rawS3Key: s3Key,
    });

    res.status(201).json({
      success: true,
      message: 'Presigned upload URL generated successfully',
      data: {
        videoId,
        uploadUrl,
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

    // 2. Cập nhật trạng thái PROCESSING
    const updatedVideo = await updateVideoStatus(videoId, 'PROCESSING');

    // 3. Gửi job vào SQS Queue cho FFmpeg Worker
    const sqsResult = await sendTranscodeJob({
      videoId: video.videoId,
      title: video.title,
      rawBucket: video.rawBucket,
      rawS3Key: video.rawS3Key,
      processedBucket: video.processedBucket,
      targetResolutions: ['1080p', '720p', '480p', '360p'],
    });

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
 * [GET /api/videos]
 * Lấy danh sách video
 */
export async function listVideos(req, res, next) {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const videos = await getAllVideos(limit);

    // Bổ sung đường dẫn HLS phát video nếu trạng thái READY
    const formattedVideos = videos.map((v) => {
      if (v.status === 'READY') {
        return {
          ...v,
          streamingUrl: `${config.cdnBaseUrl}/${v.videoId}/master.m3u8`,
          thumbnailUrl: v.thumbnailUrl || `${config.cdnBaseUrl}/${v.videoId}/thumbnail.jpg`,
        };
      }
      return v;
    });

    res.status(200).json({
      success: true,
      count: formattedVideos.length,
      data: formattedVideos,
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
    const { id } = req.params;
    const video = await getVideoById(id);

    if (!video) {
      return res.status(404).json({
        success: false,
        message: `Video not found with ID: ${id}`,
      });
    }

    const responseData = {
      ...video,
      streamingUrl:
        video.status === 'READY' ? `${config.cdnBaseUrl}/${video.videoId}/master.m3u8` : null,
      thumbnailUrl:
        video.status === 'READY'
          ? video.thumbnailUrl || `${config.cdnBaseUrl}/${video.videoId}/thumbnail.jpg`
          : null,
    };

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * [DELETE /api/videos/:id]
 * Xóa video
 */
export async function deleteVideo(req, res, next) {
  try {
    const { id } = req.params;
    const existing = await getVideoById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: `Video not found with ID: ${id}`,
      });
    }

    await deleteVideoRecord(id);

    res.status(200).json({
      success: true,
      message: `Video ${id} deleted successfully`,
    });
  } catch (error) {
    next(error);
  }
}
