import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, s3Client, s3PresignClient } from './config.js';

/** Key của file gốc: raw/{videoId}/source.{ext}. Đuôi chỉ nhận chữ và số, không thì dùng mp4. */
export function rawKeyFor(videoId, fileName) {
  const candidate = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const ext = /^[a-z0-9]{1,10}$/.test(candidate) ? candidate : 'mp4';
  return `raw/${videoId}/source.${ext}`;
}

/**
 * Presigned PUT URL cho trình duyệt upload thẳng lên S3.
 * Ký luôn Content-Length và Content-Type: S3 từ chối (403) mọi PUT gửi kích thước hoặc kiểu file
 * khác lúc xin URL, nên client không đẩy được file lớn hơn dung lượng đã khai báo.
 */
export async function presignUpload({ videoId, key, fileName, contentType, fileSize }) {
  const command = new PutObjectCommand({
    Bucket: config.rawBucket,
    Key: key,
    ContentType: contentType,
    ContentLength: fileSize,
    Metadata: { 'original-name': encodeURIComponent(fileName), 'video-id': videoId },
  });
  const uploadUrl = await getSignedUrl(s3PresignClient, command, {
    expiresIn: config.uploadUrlTtlSeconds,
    signableHeaders: new Set(['content-length', 'content-type']),
  });
  return {
    uploadUrl,
    expiresInSeconds: config.uploadUrlTtlSeconds,
    uploadHeaders: { 'Content-Type': contentType, 'Content-Length': String(fileSize) },
  };
}

/** File đã nằm trên S3 chưa. error có giá trị khi không kiểm tra được (mạng, quyền). */
export async function headObject(bucket, key) {
  try {
    const res = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, contentLength: res.ContentLength };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return { exists: false };
    console.warn(`[s3] HeadObject ${key}: ${err.message}`);
    return { exists: false, error: err.message };
  }
}
