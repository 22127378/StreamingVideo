// Truy cập bảng videos (PostgreSQL). Thay cho dynamoService.js.
import { query } from '../db/pool.js';
import { config } from '../config/aws.js';

/** Cập nhật có điều kiện không thành (ví dụ 2 request /complete cùng lúc) -> 409 */
export class ConflictError extends Error {
  constructor(message = 'Trạng thái video đã thay đổi bởi một request khác') {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

// Trường cập nhật được qua updateVideoStatus -> cột. Chỉ các tên này được ghép vào SQL.
const UPDATABLE = {
  fileSize: 'file_size',
  duration: 'duration',
  qualities: 'qualities',
  processedAt: 'processed_at',
  errorMessage: 'error_message',
  lastError: 'last_error',
  attempt: 'attempt',
};

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? undefined);

/** Hàng PostgreSQL -> object video như API trả về (camelCase) */
export function toVideo(row) {
  if (!row) return null;
  return {
    videoId: row.video_id,
    title: row.title,
    description: row.description,
    originalFileName: row.original_file_name ?? undefined,
    contentType: row.content_type,
    fileSize: row.file_size === null ? undefined : Number(row.file_size),
    ownerId: row.owner_id ?? undefined,
    tier: row.tier,
    status: row.status,
    rawS3Key: row.raw_s3_key,
    rawBucket: row.raw_bucket,
    processedBucket: row.processed_bucket,
    duration: row.duration ?? undefined,
    qualities: row.qualities ?? undefined,
    attempt: row.attempt ?? undefined,
    lastError: row.last_error ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    processedAt: iso(row.processed_at),
  };
}

export async function createVideoRecord(v) {
  const { rows } = await query(
    `INSERT INTO videos (video_id, title, description, original_file_name, content_type, file_size,
                         owner_id, tier, status, raw_s3_key, raw_bucket, processed_bucket)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'UPLOADING', $9, $10, $11)
     RETURNING *`,
    [
      v.videoId,
      v.title || 'Untitled Video',
      v.description || '',
      v.originalFileName,
      v.contentType || 'video/mp4',
      v.fileSize ?? null,
      v.ownerId ?? null,
      v.tier || 'free',
      v.rawS3Key,
      config.rawBucket,
      config.processedBucket,
    ]
  );
  return toVideo(rows[0]);
}

/**
 * Đổi trạng thái và các trường thêm. options.expectedStatus: status hiện tại phải bằng;
 * options.notStatus: status hiện tại phải khác. Không thoả thì ném ConflictError.
 */
export async function updateVideoStatus(videoId, status, extraFields = {}, options = {}) {
  const params = [videoId, status];
  const sets = ['status = $2', 'updated_at = now()'];
  for (const [key, value] of Object.entries(extraFields)) {
    const column = UPDATABLE[key];
    if (!column || value === undefined) continue;
    params.push(key === 'qualities' ? JSON.stringify(value) : value);
    sets.push(`${column} = $${params.length}`);
  }

  const where = ['video_id = $1'];
  if (options.expectedStatus) {
    params.push(options.expectedStatus);
    where.push(`status = $${params.length}`);
  }
  if (options.notStatus) {
    params.push(options.notStatus);
    where.push(`status <> $${params.length}`);
  }

  const { rows } = await query(`UPDATE videos SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`, params);
  if (rows.length === 0 && (options.expectedStatus || options.notStatus)) throw new ConflictError();
  return toVideo(rows[0]);
}

export async function getVideoById(videoId) {
  const { rows } = await query('SELECT * FROM videos WHERE video_id = $1', [videoId]);
  return toVideo(rows[0]);
}

/**
 * Video mới nhất trước, phân trang bằng keyset (createdAt, videoId): mỗi trang đúng `limit` phần tử,
 * lọc theo status không làm trang bị thiếu như GSI DynamoDB trước đây.
 * @param {{ limit: number, startKey?: { createdAt: string, videoId: string }, status?: string, ownerId?: string }}
 * @returns {Promise<{ items: Object[], lastKey: { createdAt: string, videoId: string } | undefined }>}
 */
export async function listVideos({ limit, startKey, status, ownerId }) {
  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (ownerId) {
    params.push(ownerId);
    where.push(`owner_id = $${params.length}`);
  }
  if (startKey) {
    params.push(startKey.createdAt, startKey.videoId);
    where.push(`(created_at, video_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await query(
    `SELECT * FROM videos ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, video_id DESC LIMIT $${params.length}`,
    params
  );
  const items = rows.slice(0, limit).map(toVideo);
  const last = items[items.length - 1];
  return {
    items,
    lastKey: rows.length > limit ? { createdAt: last.createdAt, videoId: last.videoId } : undefined,
  };
}

export async function deleteVideoRecord(videoId) {
  await query('DELETE FROM videos WHERE video_id = $1', [videoId]);
  return { success: true, videoId };
}
