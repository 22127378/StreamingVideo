import {
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, s3PresignClient, config } from '../config/aws.js';

/**
 * Sinh S3 Presigned URL để client có thể upload trực tiếp file video lên S3
 * @param {string} fileName Tên file gốc (ví dụ: trailer.mp4)
 * @param {string} contentType MIME type (ví dụ: video/mp4)
 * @param {string} videoId Unique ID của video
 * @returns {Promise<{ uploadUrl: string, s3Key: string, bucket: string, expiresIn: number }>}
 */
export async function generateUploadPresignedUrl(fileName, contentType, videoId, fileSize) {
  // Đuôi file lấy từ tên do client gửi, chỉ chấp nhận chữ và số để key luôn có dạng raw/{id}/source.{ext}
  const candidate = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const ext = /^[a-z0-9]{1,10}$/.test(candidate) ? candidate : 'mp4';
  const s3Key = `raw/${videoId}/source.${ext}`;
  const expiresIn = 3600; // 1 hour

  const command = new PutObjectCommand({
    Bucket: config.rawBucket,
    Key: s3Key,
    ContentType: contentType,
    ContentLength: fileSize,
    Metadata: {
      'original-name': encodeURIComponent(fileName),
      'video-id': videoId,
    },
  });

  // Ký luôn Content-Length và Content-Type: S3 từ chối (403) mọi request PUT gửi kích thước
  // hoặc kiểu file khác với lúc xin URL, nên client không thể đẩy file lớn hơn dung lượng đã khai báo.
  const uploadUrl = await getSignedUrl(s3PresignClient, command, {
    expiresIn,
    signableHeaders: new Set(['content-length', 'content-type']),
  });

  return {
    uploadUrl,
    s3Key,
    bucket: config.rawBucket,
    expiresIn,
    requiredHeaders: {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
    },
  };
}

/**
 * Kiểm tra xem file video đã được upload thành công lên S3 chưa
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function checkFileExistsOnS3(bucket, key) {
  try {
    const command = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await s3Client.send(command);
    return {
      exists: true,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
    };
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    // Nếu ở môi trường local offline chưa kết nối S3, trả về warning
    console.warn(`[s3Service] HeadObject warning for ${key}:`, error.message);
    return { exists: false, error: error.message };
  }
}

/**
 * Xóa toàn bộ object có cùng prefix (ví dụ tất cả segment HLS của một video)
 * @param {string} bucket
 * @param {string} prefix Phải kết thúc bằng "/" để không xóa nhầm prefix dài hơn
 * @returns {Promise<number>} Số object đã xóa
 */
export async function deleteS3Prefix(bucket, prefix) {
  if (!prefix.endsWith('/')) {
    throw new Error(`Prefix phải kết thúc bằng "/": ${prefix}`);
  }

  let deleted = 0;
  let continuationToken;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
    );
    const objects = (page.Contents || []).map(({ Key }) => ({ Key }));

    if (objects.length > 0) {
      const result = await s3Client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } })
      );
      if (result.Errors?.length) {
        const first = result.Errors[0];
        throw new Error(
          `Không xóa được ${result.Errors.length} object trong s3://${bucket}/${prefix} (${first.Key}: ${first.Message})`
        );
      }
      deleted += objects.length;
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}
