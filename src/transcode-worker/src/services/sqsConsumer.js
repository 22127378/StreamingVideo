import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sqsClient, config } from '../config/aws.js';
import { downloadFileFromS3, uploadDirectoryToS3 } from './s3Service.js';
import { updateVideoStatus } from './dynamoService.js';
import {
  probeVideo,
  generateThumbnail,
  transcodeHLSVariant,
  createMasterPlaylist,
  HLS_PROFILES,
} from './ffmpegService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_ROOT = path.resolve(__dirname, '../../temp');

/**
 * Xử lý một Transcode Job đơn lẻ
 * @param {Object} message AWS SQS Message
 */
export async function processTranscodeMessage(message) {
  let jobData;
  try {
    jobData = JSON.parse(message.Body);
  } catch (err) {
    console.error('❌ [SQS] JSON body không hợp lệ:', message.Body);
    return;
  }

  const {
    videoId,
    rawBucket = config.rawBucket,
    rawS3Key,
    processedBucket = config.processedBucket,
    targetResolutions = ['1080p', '720p', '480p', '360p'],
  } = jobData;

  console.log(`\n======================================================`);
  console.log(`🚀 [Worker] Bắt đầu xử lý Job cho Video: ${videoId}`);
  console.log(`📦 Nguồn: s3://${rawBucket}/${rawS3Key}`);
  console.log(`======================================================`);

  const videoWorkDir = path.join(TEMP_ROOT, videoId);
  const rawLocalPath = path.join(videoWorkDir, 'raw', path.basename(rawS3Key));
  const hlsOutputDir = path.join(videoWorkDir, 'hls');

  fs.mkdirSync(path.dirname(rawLocalPath), { recursive: true });
  fs.mkdirSync(hlsOutputDir, { recursive: true });

  try {
    // 1. Cập nhật DynamoDB sang PROCESSING
    await updateVideoStatus(videoId, 'PROCESSING');

    // 2. Tải video gốc từ S3
    await downloadFileFromS3(rawBucket, rawS3Key, rawLocalPath);

    // 3. Phân tích thông số video (ffprobe)
    console.log('🔍 [Worker] Đang phân tích thông số video gốc...');
    const meta = await probeVideo(rawLocalPath);
    console.log(`📊 Video gốc: ${meta.width}x${meta.height}, thời lượng: ${meta.duration}s, codec: ${meta.codec}`);

    // 4. Tạo ảnh Thumbnail JPG tại 2s
    console.log('📸 [Worker] Đang trích xuất Thumbnail...');
    const thumbnailTime = meta.duration > 2 ? 2 : meta.duration / 2;
    await generateThumbnail(rawLocalPath, hlsOutputDir, thumbnailTime);

    // 5. Chọn lọc các profiles độ phân giải phù hợp (không upscale)
    const validProfiles = targetResolutions
      .filter((res) => HLS_PROFILES[res])
      .map((res) => HLS_PROFILES[res])
      .filter((p) => meta.height >= p.height * 0.8 || p.name === '360p'); // Luôn có ít nhất 1 profile cơ bản

    const selectedProfiles = validProfiles.length > 0 ? validProfiles : [HLS_PROFILES['360p']];
    console.log(`🎯 Các biến thể sẽ transcode: ${selectedProfiles.map((p) => p.name).join(', ')}`);

    // 6. Transcode từng biến thể HLS
    const successfulVariants = [];
    for (const profile of selectedProfiles) {
      const variantResult = await transcodeHLSVariant(rawLocalPath, hlsOutputDir, profile);
      successfulVariants.push(variantResult);
    }

    // 7. Tạo Master Playlist (master.m3u8)
    console.log('📝 [Worker] Đang tạo master.m3u8...');
    createMasterPlaylist(successfulVariants, hlsOutputDir);

    // 8. Upload toàn bộ thư mục HLS lên S3 Processed Bucket
    await uploadDirectoryToS3(hlsOutputDir, processedBucket, videoId);

    // 9. Cập nhật DynamoDB sang READY
    const qualities = successfulVariants.map((v) => ({
      resolution: v.profile.name,
      width: v.profile.width,
      height: v.profile.height,
      bitrate: v.profile.videoBitrate,
      playlistUrl: `${config.cdnBaseUrl}/${videoId}/${v.playlist}`,
    }));

    await updateVideoStatus(videoId, 'READY', {
      duration: Math.round(meta.duration),
      masterPlaylistUrl: `${config.cdnBaseUrl}/${videoId}/master.m3u8`,
      thumbnailUrl: `${config.cdnBaseUrl}/${videoId}/thumbnail.jpg`,
      qualities,
      processedAt: new Date().toISOString(),
    });

    // 10. Xóa Message khỏi SQS Queue
    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: config.transcodeQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      })
    );
    console.log(`🧹 [SQS] Đã xóa message thành công khỏi queue.`);
    console.log(`🎉 [Worker] Hoàn tất xử lý video: ${videoId}!\n`);
  } catch (error) {
    console.error(`💥 [Worker] Xử lý video ${videoId} thất bại:`, error);
    // Cập nhật DynamoDB FAILED
    await updateVideoStatus(videoId, 'FAILED', {
      errorMessage: error.message || 'Unknown transcoding error',
    });
    // Không xóa message để SQS tự retry hoặc đưa vào DLQ
    throw error;
  } finally {
    // Dọn dẹp thư mục tạm trên ổ cứng
    try {
      if (fs.existsSync(videoWorkDir)) {
        fs.rmSync(videoWorkDir, { recursive: true, force: true });
        // console.log(`🧹 [Disk] Đã dọn dẹp thư mục tạm ${videoWorkDir}`);
      }
    } catch (cleanupErr) {
      console.warn(`⚠️ [Disk] Không thể xóa thư mục tạm:`, cleanupErr.message);
    }
  }
}

/**
 * Vòng lặp lắng nghe tin nhắn từ SQS (Long Polling Loop)
 */
export async function startSQSConsumer(isRunningSignal = { value: true }) {
  console.log(`🎧 [Worker] Đang lắng nghe hàng đợi SQS: ${config.transcodeQueueUrl}`);

  while (isRunningSignal.value) {
    try {
      const receiveCommand = new ReceiveMessageCommand({
        QueueUrl: config.transcodeQueueUrl,
        MaxNumberOfMessages: config.maxNumberOfMessages,
        WaitTimeSeconds: config.pollingWaitTimeSeconds,
        VisibilityTimeout: config.visibilityTimeout,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      });

      const response = await sqsClient.send(receiveCommand);

      if (response.Messages && response.Messages.length > 0) {
        for (const message of response.Messages) {
          try {
            await processTranscodeMessage(message);
          } catch (processErr) {
            console.error(`[Worker] Lỗi xử lý message:`, processErr.message);
          }
        }
      }
    } catch (pollError) {
      // Khi LocalStack chưa bật hoặc mạng ngắt kết nối
      if (isRunningSignal.value) {
        // console.warn(`⚠️ [SQS Polling] Đang chờ kết nối tới SQS (${pollError.message}). Thử lại sau 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
