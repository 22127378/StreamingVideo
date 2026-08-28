import { startSQSConsumer } from './services/sqsConsumer.js';
import { config } from './config/aws.js';

console.log('====================================================');
console.log('⚙️ StreamForge Transcode Worker Service Started');
console.log(`📬 SQS Queue: ${config.transcodeQueueUrl}`);
console.log(`📦 S3 Raw Bucket: ${config.rawBucket}`);
console.log(`📦 S3 Processed Bucket: ${config.processedBucket}`);
console.log(`🗄️ DynamoDB Table: ${config.videosTable}`);
console.log('====================================================');

const runningSignal = { value: true };

// Xử lý Graceful Shutdown
const handleShutdown = (signal) => {
  console.log(`\n🛑 Nhận tín hiệu ${signal}. Đang dừng Worker...`);
  runningSignal.value = false;
  setTimeout(() => {
    console.log('👋 Worker đã dừng an toàn.');
    process.exit(0);
  }, 1000);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Bắt đầu vòng lặp tiêu thụ message
startSQSConsumer(runningSignal).catch((err) => {
  console.error('💥 [Fatal Error] Worker gặp sự cố nghiêm trọng:', err);
  process.exit(1);
});
