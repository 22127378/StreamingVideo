// Dựng dữ liệu catalog từ sự kiện của service khác.
//
// Thứ tự giữa các sự kiện không được đảm bảo (SQS standard), nên mỗi bước chỉ áp dụng khi trạng thái
// hiện tại cho phép, ví dụ TranscodeStarted đến sau TranscodeCompleted không đưa video READY về
// PROCESSING. Sự kiện của video chưa có (VideoCreated chưa tới) thì để xử lý lại sau; của video đã
// xoá thì bỏ qua.
import { EVENT_TYPES, RetryLaterError } from '@streamforge/shared/events';
import * as repo from './repository.js';
import { deleteS3Prefix } from './storage.js';

/**
 * @param {{ id: string, type: string, detail: object }} event
 * @param {{ purge?: (video: object) => Promise<void> }} deps
 * @returns {Promise<string>} kết quả: applied | ignored | duplicate | deleted | unknown
 */
export async function handleEvent(event, { purge = purgeLateOutput } = {}) {
  const d = event.detail || {};
  if (!d.videoId) return 'unknown';

  let outcome = 'unknown';
  let lateOutput = false;
  const fresh = await repo.onceForEvent(event, async (q) => {
    if (await repo.isDeleted(d.videoId, q)) {
      // Worker có thể vẫn ghi xong HLS sau khi video bị xoá: dọn lại phần đó
      lateOutput = event.type === EVENT_TYPES.TranscodeCompleted;
      outcome = 'deleted';
      return;
    }
    switch (event.type) {
      case EVENT_TYPES.VideoCreated:
        await repo.upsertFromUpload(q, d, { uploaded: false });
        outcome = 'applied';
        return;
      case EVENT_TYPES.VideoUploaded:
        await repo.upsertFromUpload(q, d, { uploaded: true });
        outcome = 'applied';
        return;
      case EVENT_TYPES.TranscodeStarted:
        outcome = await repo.applyTranscodeStarted(q, d);
        break;
      case EVENT_TYPES.TranscodeCompleted:
        outcome = await repo.applyTranscodeCompleted(q, d);
        break;
      case EVENT_TYPES.TranscodeFailed:
        outcome = await repo.applyTranscodeFailed(q, d);
        break;
      case EVENT_TYPES.VideoViewed:
        outcome = await repo.applyVideoViewed(q, d);
        // Lượt xem của video không còn thì bỏ qua, không cần chờ
        if (outcome === 'missing') outcome = 'ignored';
        return;
      default:
        outcome = 'unknown';
        return;
    }
    // Ném lỗi để huỷ transaction (cả ghi nhận sự kiện), SQS giao lại sau
    if (outcome === 'missing') throw new RetryLaterError(`video ${d.videoId} chưa có trong catalog`);
  });

  if (!fresh) return 'duplicate';
  if (lateOutput) await purge({ videoId: d.videoId, processedBucket: d.processedBucket });
  return outcome;
}

async function purgeLateOutput(video) {
  if (!video.processedBucket) return;
  const n = await deleteS3Prefix(video.processedBucket, `${video.videoId}/`);
  if (n) console.warn(`[catalog] removed ${n} HLS files written after video ${video.videoId} was deleted`);
}
