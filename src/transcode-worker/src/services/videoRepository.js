// Worker chỉ cập nhật trạng thái video (user DB streamforge_worker: SELECT, UPDATE trên videos).
import { query } from '../db/pool.js';

/** Video đã bị xoá hoặc đang bị xoá: worker bỏ job, không tạo lại bản ghi */
export class VideoGoneError extends Error {
  constructor(videoId) {
    super(`Video ${videoId} không còn tồn tại hoặc đang bị xoá`);
    this.name = 'VideoGoneError';
  }
}

// Trường worker được ghi -> cột. Các trường khác (ví dụ URL) bị bỏ qua: API tự tính từ CDN_BASE_URL.
const UPDATABLE = {
  duration: 'duration',
  qualities: 'qualities',
  processedAt: 'processed_at',
  errorMessage: 'error_message',
  lastError: 'last_error',
  attempt: 'attempt',
};

/**
 * Cập nhật trạng thái và metadata, chỉ khi video còn tồn tại và không ở DELETING.
 * @throws VideoGoneError
 */
export async function updateVideoStatus(videoId, status, extraFields = {}) {
  const params = [videoId, status];
  const sets = ['status = $2', 'updated_at = now()'];
  for (const [key, value] of Object.entries(extraFields)) {
    const column = UPDATABLE[key];
    if (!column || value === undefined) continue;
    params.push(key === 'qualities' ? JSON.stringify(value) : value);
    sets.push(`${column} = $${params.length}`);
  }
  const { rowCount } = await query(
    `UPDATE videos SET ${sets.join(', ')} WHERE video_id = $1 AND status <> 'DELETING'`,
    params
  );
  if (rowCount === 0) throw new VideoGoneError(videoId);
  console.log(`[DB] Cập nhật Video ${videoId} -> Status: [${status}]`);
}
