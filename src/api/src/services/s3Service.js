import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, config } from '../config/aws.js';

/**
 * Sinh S3 Presigned URL để client có thể upload trực tiếp file video lên S3
 * @param {string} fileName Tên file gốc (ví dụ: trailer.mp4)
 * @param {string} contentType MIME type (ví dụ: video/mp4)
 * @param {string} videoId Unique ID của video
 * @returns {Promise<{ uploadUrl: string, s3Key: string, bucket: string, expiresIn: number }>}
 */
export async function generateUploadPresignedUrl(fileName, contentType, videoId) {
  // Lấy đuôi file mở rộng an toàn
  const ext = fileName.includes('.') ? fileName.split('.').pop() : 'mp4';
  const s3Key = `raw/${videoId}/source.${ext}`;
  const expiresIn = 3600; // 1 hour

  const command = new PutObjectCommand({
    Bucket: config.rawBucket,
    Key: s3Key,
    ContentType: contentType,
    Metadata: {
      'original-name': encodeURIComponent(fileName),
      'video-id': videoId,
    },
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });

  return {
    uploadUrl,
    s3Key,
    bucket: config.rawBucket,
    expiresIn,
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
