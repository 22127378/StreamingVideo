import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { S3Client } from '@aws-sdk/client-s3';
import { awsClientConfig } from '@streamforge/shared/aws';

const env = process.env;

export const s3Client = new S3Client({
  ...awsClientConfig,
  forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE === 'true' || Boolean(env.AWS_ENDPOINT_URL),
});

// CloudFront là dịch vụ global, API của nó nằm ở us-east-1
export const cloudfrontClient = new CloudFrontClient({ ...awsClientConfig, region: 'us-east-1' });

export const config = {
  rawBucket: env.S3_RAW_UPLOADS_BUCKET || 'streamforge-raw-uploads',
  processedBucket: env.S3_PROCESSED_BUCKET || 'streamforge-processed',
  cdnBaseUrl: env.CDN_BASE_URL || 'http://localhost:4566/streamforge-processed',
  // Có thì xoá cache CloudFront của video khi xoá. Bỏ trống khi chạy local.
  cloudfrontDistributionId: env.CLOUDFRONT_DISTRIBUTION_ID || '',
  // Hàng đợi nhận sự kiện từ EventBridge. Bỏ trống thì không chạy consumer (ví dụ khi test).
  eventsQueueUrl: env.CATALOG_EVENTS_QUEUE_URL || '',
};
