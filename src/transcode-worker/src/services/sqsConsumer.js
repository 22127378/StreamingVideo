import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import fs from 'fs';
import { setTimeout as sleep } from 'node:timers/promises';
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
  selectProfiles,
} from './ffmpegService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_ROOT = path.resolve(__dirname, '../../temp');

/**
 * Định kỳ gia hạn visibility timeout của message trong lúc đang transcode,
 * tránh message hiện lại trên queue và bị worker khác xử lý trùng với video dài.
 * @param {string} receiptHandle
 * @returns {() => void} Hàm dừng heartbeat
 */
export function startVisibilityHeartbeat(receiptHandle, {
  intervalSeconds = config.heartbeatIntervalSeconds,
  visibilityTimeout = config.visibilityTimeout,
  client = sqsClient,
} = {}) {
  const timer = setInterval(async () => {
    try {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: config.transcodeQueueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilityTimeout,
        })
      );
      console.log(`\n[SQS] Gia hạn visibility thêm ${visibilityTimeout}s`);
    } catch (err) {
      console.warn(`\n[SQS] Không gia hạn được visibility:`, err.message);
    }
  }, intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Đặt visibility timeout của message. Dùng 0 để trả message về queue ngay,
 * hoặc một số giây để hẹn giờ cho lần retry tiếp theo.
 * @param {string} receiptHandle
 * @param {number} seconds
 */
async function setMessageVisibility(receiptHandle, seconds) {
  try {
    await sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: config.transcodeQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      })
    );
  } catch (err) {
    console.warn(`[SQS] Không đổi được visibility của message:`, err.message);
  }
}

/**
 * Quyết định cách xử lý một lần thất bại dựa trên số lần message đã được nhận.
 * Lần cuối cùng (bằng maxReceiveCount) thì đánh dấu FAILED vì SQS sẽ chuyển message sang DLQ.
 * @param {number} receiveCount ApproximateReceiveCount của message
 * @param {{ maxReceiveCount: number, retryDelaySeconds: number }} options
 * @returns {{ final: boolean, retryInSeconds: number }}
 */
export function planFailure(receiveCount, { maxReceiveCount, retryDelaySeconds }) {
  const attempt = Math.max(1, receiveCount || 1);
  if (attempt >= maxReceiveCount) {
    return { final: true, retryInSeconds: 0 };
  }
  return { final: false, retryInSeconds: Math.min(attempt * retryDelaySeconds, 43200) };
}

/**
 * Xử lý một Transcode Job đơn lẻ
 * @param {Object} message AWS SQS Message (nhận với AttributeNames: ['All'])
 * @param {{ signal?: AbortSignal }} options Khi signal bị abort, job dừng và message được trả về queue
 * @returns {Promise<'done' | 'retry' | 'failed' | 'released' | 'invalid'>}
 */
export async function processTranscodeMessage(message, { signal } = {}) {
  let jobData;
  try {
    jobData = JSON.parse(message.Body);
  } catch (err) {
    console.error('[SQS] JSON body không hợp lệ, để SQS chuyển sang DLQ:', message.Body);
    return 'invalid';
  }

  const {
    videoId,
    rawBucket = config.rawBucket,
    rawS3Key,
    processedBucket = config.processedBucket,
    targetResolutions = ['1080p', '720p', '480p', '360p'],
  } = jobData;

  if (!videoId || !rawS3Key) {
    console.error('[SQS] Message thiếu videoId hoặc rawS3Key, để SQS chuyển sang DLQ:', message.Body);
    return 'invalid';
  }

  const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount || '1', 10);
  console.log(`[Worker] Bắt đầu xử lý Job cho Video: ${videoId} (lần ${receiveCount}/${config.maxReceiveCount})`);
  console.log(`[Worker] Nguồn: s3://${rawBucket}/${rawS3Key}`);

  const videoWorkDir = path.join(TEMP_ROOT, videoId);
  const rawLocalPath = path.join(videoWorkDir, 'raw', path.basename(rawS3Key));
  const hlsOutputDir = path.join(videoWorkDir, 'hls');

  fs.mkdirSync(path.dirname(rawLocalPath), { recursive: true });
  fs.mkdirSync(hlsOutputDir, { recursive: true });

  const stopHeartbeat = startVisibilityHeartbeat(message.ReceiptHandle);

  try {
    signal?.throwIfAborted();

    // 1. Cập nhật DynamoDB sang PROCESSING
    await updateVideoStatus(videoId, 'PROCESSING', { attempt: receiveCount });

    // 2. Tải video gốc từ S3
    await downloadFileFromS3(rawBucket, rawS3Key, rawLocalPath, { signal });

    // 3. Phân tích thông số video (ffprobe)
    console.log('[Worker] Đang phân tích thông số video gốc...');
    const meta = await probeVideo(rawLocalPath);
    console.log(`Video gốc: ${meta.width}x${meta.height}, thời lượng: ${meta.duration}s, codec: ${meta.codec}`);

    // 4. Tạo ảnh Thumbnail JPG tại 2s
    console.log('[Worker] Đang trích xuất Thumbnail...');
    const thumbnailTime = meta.duration > 2 ? 2 : meta.duration / 2;
    await generateThumbnail(rawLocalPath, hlsOutputDir, thumbnailTime);

    // 5. Chọn các profile phù hợp theo cạnh ngắn (không upscale, hỗ trợ video dọc)
    const selectedProfiles = selectProfiles(meta, targetResolutions);
    console.log(`Các biến thể sẽ transcode: ${selectedProfiles.map((p) => p.name).join(', ')}`);

    // 6. Transcode từng biến thể HLS
    const successfulVariants = [];
    for (const profile of selectedProfiles) {
      signal?.throwIfAborted();
      const variantResult = await transcodeHLSVariant(rawLocalPath, hlsOutputDir, profile, meta, { signal });
      successfulVariants.push(variantResult);
    }

    // 7. Tạo Master Playlist (master.m3u8)
    console.log('[Worker] Đang tạo master.m3u8...');
    createMasterPlaylist(successfulVariants, hlsOutputDir);

    // 8. Upload toàn bộ thư mục HLS lên S3 Processed Bucket
    await uploadDirectoryToS3(hlsOutputDir, processedBucket, videoId, { signal });

    // 9. Cập nhật DynamoDB sang READY
    const qualities = successfulVariants.map((v) => ({
      resolution: v.profile.name,
      width: v.width,
      height: v.height,
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
    console.log(`[SQS] Đã xóa message thành công khỏi queue.`);
    console.log(`[Worker] Hoàn tất xử lý video: ${videoId}`);
    return 'done';
  } catch (error) {
    // Worker đang tắt: không tính là lỗi, trả message về queue để worker khác nhận ngay
    if (signal?.aborted) {
      stopHeartbeat();
      await setMessageVisibility(message.ReceiptHandle, 0);
      console.warn(`[Worker] Đã dừng job ${videoId} và trả message về queue`);
      return 'released';
    }

    console.error(`[Worker] Xử lý video ${videoId} thất bại:`, error);
    const errorMessage = error.message || 'Unknown transcoding error';
    const plan = planFailure(receiveCount, config);

    // Message không bị xóa: SQS sẽ giao lại, hoặc chuyển sang DLQ ở lần cuối
    try {
      if (plan.final) {
        await updateVideoStatus(videoId, 'FAILED', { errorMessage, attempt: receiveCount });
      } else {
        await updateVideoStatus(videoId, 'PROCESSING', {
          lastError: errorMessage,
          attempt: receiveCount,
        });
      }
    } catch (dbErr) {
      console.error(`[Worker] Không cập nhật được trạng thái lỗi của ${videoId}:`, dbErr.message);
    }

    stopHeartbeat();
    if (plan.final) {
      // Trả message về ngay để SQS chuyển sang DLQ ở lần nhận kế tiếp, không chờ hết visibility timeout
      await setMessageVisibility(message.ReceiptHandle, 0);
      return 'failed';
    }

    await setMessageVisibility(message.ReceiptHandle, plan.retryInSeconds);
    console.warn(`[Worker] Sẽ thử lại video ${videoId} sau ${plan.retryInSeconds}s`);
    return 'retry';
  } finally {
    stopHeartbeat();
    // Dọn dẹp thư mục tạm trên ổ cứng
    try {
      if (fs.existsSync(videoWorkDir)) {
        fs.rmSync(videoWorkDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.warn(`[Disk] Không thể xóa thư mục tạm:`, cleanupErr.message);
    }
  }
}

/**
 * Vòng lặp lắng nghe tin nhắn từ SQS (Long Polling Loop)
 * @param {{ stopSignal?: AbortSignal, jobSignal?: AbortSignal }} options
 *   stopSignal: ngừng nhận message mới (hủy luôn lệnh long poll đang chờ)
 *   jobSignal: hủy job đang chạy và trả message về queue
 */
export async function startSQSConsumer({ stopSignal, jobSignal } = {}) {
  console.log(`[Worker] Đang lắng nghe hàng đợi SQS: ${config.transcodeQueueUrl}`);

  while (!stopSignal?.aborted) {
    let response;
    try {
      response = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: config.transcodeQueueUrl,
          MaxNumberOfMessages: config.maxNumberOfMessages,
          WaitTimeSeconds: config.pollingWaitTimeSeconds,
          VisibilityTimeout: config.visibilityTimeout,
          AttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        }),
        { abortSignal: stopSignal }
      );
    } catch (pollError) {
      if (stopSignal?.aborted) break;
      // Khi LocalStack chưa bật hoặc mạng ngắt kết nối
      console.warn(`[SQS Polling] Đang chờ kết nối tới SQS (${pollError.message}). Thử lại sau 5s...`);
      await sleep(5000, undefined, { signal: stopSignal }).catch(() => {});
      continue;
    }

    for (const message of response.Messages || []) {
      // Đã nhận tín hiệu tắt trước khi bắt đầu message này: trả lại queue
      if (stopSignal?.aborted) {
        await setMessageVisibility(message.ReceiptHandle, 0);
        continue;
      }
      try {
        await processTranscodeMessage(message, { signal: jobSignal });
      } catch (processErr) {
        console.error(`[Worker] Lỗi xử lý message:`, processErr.message);
      }
    }
  }

  console.log('[Worker] Đã ngừng nhận message mới.');
}
