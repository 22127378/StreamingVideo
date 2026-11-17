import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root .env or local .env
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config();

const region = process.env.AWS_REGION || 'us-east-1';
const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
};

const baseConfig = {
  region,
  ...(endpoint ? { endpoint, credentials } : {}),
};

// S3 Client (forcePathStyle for LocalStack / MinIO)
const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === 'true' || !!endpoint;
export const s3Client = new S3Client({ ...baseConfig, forcePathStyle });

// Presigned URL do trình duyệt gọi, nên phải dùng host mà trình duyệt truy cập được.
// Khi API chạy trong Docker, AWS_ENDPOINT_URL là http://localstack:4566 (chỉ trong mạng Docker),
// còn AWS_S3_PUBLIC_ENDPOINT là http://localhost:4566. Trên AWS thật thì bỏ trống cả hai.
const publicEndpoint = process.env.AWS_S3_PUBLIC_ENDPOINT || undefined;
export const s3PresignClient = publicEndpoint
  ? new S3Client({ ...baseConfig, endpoint: publicEndpoint, credentials, forcePathStyle })
  : s3Client;

// DynamoDB Document Client
const ddbClient = new DynamoDBClient(baseConfig);
export const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: true,
  },
});

// SQS Client
export const sqsClient = new SQSClient(baseConfig);

// Configuration Constants
export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  rawBucket: process.env.S3_RAW_UPLOADS_BUCKET || 'streamforge-raw-uploads',
  processedBucket: process.env.S3_PROCESSED_BUCKET || 'streamforge-processed',
  transcodeQueueUrl:
    process.env.SQS_TRANSCODE_QUEUE_URL ||
    'http://localhost:4566/000000000000/streamforge-transcode-queue',
  videosTable: process.env.DYNAMODB_VIDEOS_TABLE || 'streamforge-videos',
  videosByCreatedAtIndex: process.env.DYNAMODB_VIDEOS_CREATED_AT_INDEX || 'entityType-createdAt-index',
  cdnBaseUrl: process.env.CDN_BASE_URL || 'http://localhost:4566/streamforge-processed',
  // Có thì API xoá cache CloudFront của video khi DELETE. Bỏ trống khi chạy local (LocalStack).
  cloudfrontDistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID || '',
  auth: resolveAuth(),
  // Signed cookies cho /videos/* (CloudFront key group). Bỏ trống khi chạy local: HLS không bị chặn.
  cloudfrontKeyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID || '',
  cloudfrontPrivateKey: (process.env.CLOUDFRONT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  playbackCookieTtlSeconds: parseInt(process.env.PLAYBACK_COOKIE_TTL_SECONDS || '7200', 10),
  // Giới hạn chi phí: dung lượng upload tối đa (mặc định 2 GiB)
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(2 * 1024 ** 3), 10),
  // Số request tạo upload/token mỗi IP trong một cửa sổ thời gian (0 = tắt)
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '30', 10),
  rateLimitWindowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '600', 10),
  // Số proxy đứng trước API (CloudFront + ALB = 2) để lấy đúng IP client từ X-Forwarded-For
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),
};

/**
 * Chế độ xác thực:
 * - cognito: có COGNITO_USER_POOL_ID. API xác minh access token của Cognito, gói = group "premium".
 * - dev: chạy local không có Cognito (LocalStack). API tự cấp token HS256 ký bằng JWT_SECRET qua
 *   POST /api/auth/dev-login, ai cũng chọn được gói. Ở production chỉ bật khi ALLOW_DEV_AUTH=true
 *   (docker compose), và khi đó bắt buộc JWT_SECRET đủ dài.
 */
function resolveAuth() {
  const production = (process.env.NODE_ENV || 'development') === 'production';
  const userPoolId = process.env.COGNITO_USER_POOL_ID || '';

  if (userPoolId) {
    const clientId = process.env.COGNITO_CLIENT_ID;
    if (!clientId) throw new Error('COGNITO_CLIENT_ID is required when COGNITO_USER_POOL_ID is set');
    return {
      mode: 'cognito',
      userPoolId,
      clientId,
      region: userPoolId.split('_')[0],
      // Domain trang đăng nhập (https://xxx.auth.<region>.amazoncognito.com), frontend dùng để redirect
      domain: process.env.COGNITO_DOMAIN || '',
      premiumGroup: process.env.COGNITO_PREMIUM_GROUP || 'premium',
    };
  }

  if (production && process.env.ALLOW_DEV_AUTH !== 'true') {
    throw new Error('COGNITO_USER_POOL_ID is required in production (set ALLOW_DEV_AUTH=true only for local Docker)');
  }
  const secret = process.env.JWT_SECRET;
  if (production && (!secret || secret.length < 32)) {
    throw new Error('JWT_SECRET phải được cấu hình và dài ít nhất 32 ký tự khi dùng dev auth với NODE_ENV=production');
  }
  return { mode: 'dev', jwtSecret: secret || 'streamforge-local-dev-secret' };
}
