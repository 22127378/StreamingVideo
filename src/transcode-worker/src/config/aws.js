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

// S3 Client
export const s3Client = new S3Client({
  ...baseConfig,
  forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true' || !!endpoint,
});

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

export const config = {
  rawBucket: process.env.S3_RAW_UPLOADS_BUCKET || 'streamforge-raw-uploads',
  processedBucket: process.env.S3_PROCESSED_BUCKET || 'streamforge-processed',
  transcodeQueueUrl:
    process.env.SQS_TRANSCODE_QUEUE_URL ||
    'http://localhost:4566/000000000000/streamforge-transcode-queue',
  videosTable: process.env.DYNAMODB_VIDEOS_TABLE || 'streamforge-videos',
  cdnBaseUrl: process.env.CDN_BASE_URL || 'http://localhost:4566/streamforge-processed',
  // Polling configuration
  pollingWaitTimeSeconds: parseInt(process.env.SQS_POLLING_WAIT_TIME || '10', 10),
  maxNumberOfMessages: parseInt(process.env.SQS_MAX_MESSAGES || '1', 10),
  visibilityTimeout: parseInt(process.env.SQS_VISIBILITY_TIMEOUT || '300', 10),
};
