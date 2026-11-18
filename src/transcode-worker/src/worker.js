import { setTimeout as sleep } from 'node:timers/promises';
import { installConsoleBridge } from './logger.js';
import { startSQSConsumer } from './services/sqsConsumer.js';
import { config } from './config/aws.js';
import { startMetricsServer } from './metrics.js';

installConsoleBridge();
startMetricsServer();

const jobMode = config.workerMode === 'job';
console.log(`StreamForge Transcode Worker started (${jobMode ? 'job: tối đa 1 video rồi thoát' : 'service'})`);
console.log(`SQS Queue: ${config.transcodeQueueUrl}`);
console.log(`S3 Raw Bucket: ${config.rawBucket}`);
console.log(`S3 Processed Bucket: ${config.processedBucket}`);
console.log(`Event bus: ${process.env.EVENT_BUS_NAME || '(not set)'}`);

// stopController: ngừng nhận message mới. jobController: hủy job đang chạy.
const stopController = new AbortController();
const jobController = new AbortController();

// Graceful shutdown: ngừng poll ngay, cho job hiện tại thời gian để xong.
// Hết thời gian chờ (hoặc nhận tín hiệu lần hai) thì hủy job và trả message về queue.
const handleShutdown = (signal) => {
  if (stopController.signal.aborted) {
    console.log(`\nNhận ${signal} lần hai. Hủy job đang chạy...`);
    jobController.abort(new Error(`Worker shutdown (${signal})`));
    return;
  }

  console.log(`\nNhận tín hiệu ${signal}. Ngừng nhận job mới, chờ job hiện tại tối đa ${config.shutdownGraceSeconds}s...`);
  stopController.abort(new Error(`Worker shutdown (${signal})`));
  setTimeout(() => {
    if (!jobController.signal.aborted) {
      console.log('Hết thời gian chờ. Hủy job đang chạy...');
      jobController.abort(new Error('Worker shutdown timeout'));
    }
  }, config.shutdownGraceSeconds * 1000).unref();
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

startSQSConsumer({
  stopSignal: stopController.signal,
  jobSignal: jobController.signal,
  ...(jobMode ? { maxJobs: 1, idleTimeoutSeconds: config.jobIdleTimeoutSeconds } : {}),
})
  .then(async ({ processed, reason }) => {
    // Pod của Job sống ngắn: chờ một nhịp scrape để Prometheus lấy được metric của job vừa xong
    if (jobMode && processed > 0 && !stopController.signal.aborted) {
      await sleep(config.metricsLingerSeconds * 1000, undefined, { signal: stopController.signal }).catch(() => {});
    }
    console.log(`Worker đã dừng an toàn (${reason}, ${processed} message).`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[Fatal Error] Worker gặp sự cố nghiêm trọng:', err);
    process.exit(1);
  });
