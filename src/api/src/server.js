import { createApp } from './app.js';
import { config } from './config/aws.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log('====================================================');
  console.log(`🎬 StreamForge API Server running on port ${config.port}`);
  console.log(`🌍 Environment: ${config.nodeEnv}`);
  console.log(`📦 S3 Raw Bucket: ${config.rawBucket}`);
  console.log(`📬 SQS Queue URL: ${config.transcodeQueueUrl}`);
  console.log(`🗄️ DynamoDB Table: ${config.videosTable}`);
  console.log(`🔗 Healthcheck: http://localhost:${config.port}/health`);
  console.log('====================================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
