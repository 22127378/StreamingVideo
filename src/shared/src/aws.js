// Cấu hình AWS SDK chung. Chạy local thì AWS_ENDPOINT_URL trỏ tới LocalStack và dùng credentials giả.
import dotenv from 'dotenv';
import path from 'node:path';

// .env ở thư mục gốc repo (khi chạy bằng npm trên máy), rồi .env trong thư mục hiện tại
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), quiet: true });
dotenv.config({ quiet: true });

export const region = process.env.AWS_REGION || 'us-east-1';
const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

/** Tham số chung cho mọi client AWS SDK */
export const awsClientConfig = {
  region,
  ...(endpoint
    ? {
        endpoint,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
        },
      }
    : {}),
};

export const isLocalStack = Boolean(endpoint);
