import { S3Client } from '@aws-sdk/client-s3';
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

// S3 Client
export const s3Client = new S3Client({
  ...baseConfig,
  forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' || !!endpoint,
});

// SQS Client
export const sqsClient = new SQSClient(baseConfig);

export const config = {
  rawBucket: process.env.S3_RAW_UPLOADS_BUCKET || 'streamforge-raw-uploads',
  processedBucket: process.env.S3_PROCESSED_BUCKET || 'streamforge-processed',
  transcodeQueueUrl:
    process.env.SQS_TRANSCODE_QUEUE_URL ||
    'http://localhost:4566/000000000000/streamforge-transcode-queue',
  cdnBaseUrl: process.env.CDN_BASE_URL || 'http://localhost:4566/streamforge-processed',
  // Polling configuration
  pollingWaitTimeSeconds: parseInt(process.env.SQS_POLLING_WAIT_TIME || '10', 10),
  maxNumberOfMessages: parseInt(process.env.SQS_MAX_MESSAGES || '1', 10),
  visibilityTimeout: parseInt(process.env.SQS_VISIBILITY_TIMEOUT || '300', 10),
  // Gia hạn visibility định kỳ khi đang transcode (phải nhỏ hơn visibilityTimeout)
  heartbeatIntervalSeconds: parseInt(process.env.SQS_HEARTBEAT_INTERVAL || '120', 10),
  // Phải khớp maxReceiveCount trong redrive policy của queue (scripts/init-aws-local.sh)
  maxReceiveCount: parseInt(process.env.SQS_MAX_RECEIVE_COUNT || '3', 10),
  // Lần thử thứ n sẽ chờ n * retryDelaySeconds trước khi message hiện lại
  retryDelaySeconds: parseInt(process.env.SQS_RETRY_DELAY || '30', 10),
  // Khi nhận SIGTERM, chờ job hiện tại tối đa chừng này giây rồi trả message về queue
  shutdownGraceSeconds: parseInt(process.env.SHUTDOWN_GRACE_SECONDS || '25', 10),
  // Giới hạn chi phí transcode: video dài hơn hoặc lớn hơn mức này bị từ chối, không retry
  maxSourceDurationSeconds: parseInt(process.env.MAX_SOURCE_DURATION_SECONDS || '1800', 10),
  maxSourceDimension: parseInt(process.env.MAX_SOURCE_DIMENSION || '4096', 10),
  uploadConcurrency: parseInt(process.env.S3_UPLOAD_CONCURRENCY || '8', 10),
  // service: chạy mãi, xử lý message liên tục (docker compose, chạy local).
  // job: mỗi process xử lý tối đa 1 message rồi thoát (KEDA ScaledJob trên EKS).
  workerMode: process.env.WORKER_MODE === 'job' ? 'job' : 'service',
  // Chế độ job: chờ message tối đa chừng này giây, không có thì thoát (0 = chờ mãi)
  jobIdleTimeoutSeconds: parseInt(process.env.JOB_IDLE_TIMEOUT_SECONDS || '300', 10),
  // Chế độ job: giữ process thêm chừng này giây sau khi xong để Prometheus kịp lấy metric cuối
  metricsLingerSeconds: parseInt(process.env.METRICS_LINGER_SECONDS || '15', 10),
};
