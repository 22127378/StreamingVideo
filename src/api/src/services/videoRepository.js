// Truy cập bảng videos (PostgreSQL). Thay cho dynamoService.js.
import { query, withTransaction } from '../db/pool.js';
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
    viewCount: row.view_count === undefined ? 0 : Number(row.view_count),
    ratingAvg: row.rating_avg === undefined || row.rating_avg === null ? 0 : Number(row.rating_avg),
    ratingCount: row.rating_count ?? 0,
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

// Kiểu sắp xếp -> cột chính. Khoá phụ luôn là (created_at, video_id) để thứ tự ổn định.
// Chỉ các tên trong bảng này được ghép vào SQL.
export const SORTS = {
  newest: { column: null, dir: 'DESC' },
  oldest: { column: null, dir: 'ASC' },
  views: { column: 'view_count', dir: 'DESC' },
  rating: { column: 'rating_avg', dir: 'DESC' },
};

export const PERIODS = { day: '1 day', week: '7 days', month: '30 days', year: '365 days' };

/**
 * Danh sách video, phân trang bằng keyset: mỗi trang đúng `limit` phần tử, không trùng hay sót
 * khi có video mới chen vào giữa hai lần tải.
 * Con trỏ là giá trị của hàng cuối trang: { value (cột sắp xếp), createdAt, videoId }.
 * @param {{ limit: number, startKey?: { value?: string, createdAt: string, videoId: string },
 *   status?: string, ownerId?: string, tier?: 'free' | 'premium', sort?: keyof SORTS,
 *   period?: keyof PERIODS }} options
 */
export async function listVideos({ limit, startKey, status, ownerId, tier, sort = 'newest', period }) {
  const { column, dir } = SORTS[sort] || SORTS.newest;
  const cmp = dir === 'DESC' ? '<' : '>';
  const params = [];
  const where = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (status) where.push(`status = ${add(status)}`);
  if (ownerId) where.push(`owner_id = ${add(ownerId)}`);
  if (tier) where.push(`tier = ${add(tier)}`);
  if (period && PERIODS[period]) where.push(`created_at >= now() - ${add(PERIODS[period])}::interval`);
  if (startKey) {
    const created = `${add(startKey.createdAt)}::timestamptz`;
    const id = `${add(startKey.videoId)}::uuid`;
    where.push(
      column
        ? `(${column}, created_at, video_id) ${cmp} (${add(startKey.value ?? '0')}::numeric, ${created}, ${id})`
        : `(created_at, video_id) ${cmp} (${created}, ${id})`
    );
  }
  const order = [column && `${column} ${dir}`, `created_at ${dir}`, `video_id ${dir}`].filter(Boolean).join(', ');
  const { rows } = await query(
    `SELECT * FROM videos ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${order} LIMIT ${add(limit + 1)}`,
    params
  );
  const items = rows.slice(0, limit).map(toVideo);
  const lastRow = rows[limit - 1];
  return {
    items,
    lastKey:
      rows.length > limit
        ? {
            ...(column ? { value: String(lastRow[column]) } : {}),
            createdAt: iso(lastRow.created_at),
            videoId: lastRow.video_id,
          }
        : undefined,
  };
}

/** Tăng lượt xem (gọi khi cấp quyền phát thành công) */
export async function incrementViews(videoId) {
  const { rows } = await query(
    'UPDATE videos SET view_count = view_count + 1 WHERE video_id = $1 RETURNING view_count',
    [videoId]
  );
  return rows[0] ? Number(rows[0].view_count) : undefined;
}

/**
 * Chấm 1-5 sao; chấm lại thì ghi đè. Tổng và số lượt chấm trên videos được tính lại trong cùng
 * transaction, nên luôn khớp với video_ratings.
 * @returns {Promise<{ ratingAvg: number, ratingCount: number, myRating: number }>}
 */
export async function rateVideo(videoId, userId, stars) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO video_ratings (video_id, user_id, stars) VALUES ($1, $2, $3)
       ON CONFLICT (video_id, user_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
      [videoId, userId, stars]
    );
    const { rows } = await client.query(
      `UPDATE videos v SET rating_sum = r.sum, rating_count = r.count
       FROM (SELECT coalesce(sum(stars), 0)::int AS sum, count(*)::int AS count
             FROM video_ratings WHERE video_id = $1) r
       WHERE v.video_id = $1
       RETURNING v.rating_avg, v.rating_count`,
      [videoId]
    );
    return { ratingAvg: Number(rows[0].rating_avg), ratingCount: rows[0].rating_count, myRating: stars };
  });
}

/** Số sao người dùng đã chấm cho video, hoặc null */
export async function getUserRating(videoId, userId) {
  const { rows } = await query('SELECT stars FROM video_ratings WHERE video_id = $1 AND user_id = $2', [
    videoId,
    userId,
  ]);
  return rows[0]?.stars ?? null;
}

export async function deleteVideoRecord(videoId) {
  await query('DELETE FROM videos WHERE video_id = $1', [videoId]);
  return { success: true, videoId };
}
