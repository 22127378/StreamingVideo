import { S3Client } from '@aws-sdk/client-s3';
import { awsClientConfig } from '@streamforge/shared/aws';

const env = process.env;
const forcePathStyle = env.AWS_S3_FORCE_PATH_STYLE === 'true' || Boolean(env.AWS_ENDPOINT_URL);

export const s3Client = new S3Client({ ...awsClientConfig, forcePathStyle });

// Presigned URL do trình duyệt gọi, nên phải dùng host mà trình duyệt truy cập được.
// Khi chạy trong Docker, AWS_ENDPOINT_URL là http://localstack:4566 (chỉ trong mạng Docker),
// còn AWS_S3_PUBLIC_ENDPOINT là http://localhost:4566. Trên AWS thật thì bỏ trống cả hai.
export const s3PresignClient = env.AWS_S3_PUBLIC_ENDPOINT
  ? new S3Client({ ...awsClientConfig, endpoint: env.AWS_S3_PUBLIC_ENDPOINT, forcePathStyle })
  : s3Client;

export const config = {
  rawBucket: env.S3_RAW_UPLOADS_BUCKET || 'streamforge-raw-uploads',
  processedBucket: env.S3_PROCESSED_BUCKET || 'streamforge-processed',
  // Giới hạn chi phí: dung lượng upload tối đa (mặc định 2 GiB)
  maxUploadBytes: parseInt(env.MAX_UPLOAD_BYTES || String(2 * 1024 ** 3), 10),
  uploadUrlTtlSeconds: 3600,
  targetResolutions: ['1080p', '720p', '480p', '360p'],
  rateLimitMax: parseInt(env.RATE_LIMIT_MAX || '30', 10),
  rateLimitWindowSeconds: parseInt(env.RATE_LIMIT_WINDOW_SECONDS || '600', 10),
};
