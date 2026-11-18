// Bảng của catalog (schema catalog): videos, video_ratings, processed_events, deleted_videos.
import { createDb } from '@streamforge/shared/db';
import { ConflictError } from '@streamforge/shared/errors';

export const db = createDb();

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? undefined);

/** Hàng PostgreSQL -> object video (camelCase) */
export function toVideo(row) {
  if (!row) return null;
  return {
    videoId: row.video_id,
    title: row.title,
    description: row.description,
    originalFileName: row.original_file_name ?? undefined,
    contentType: row.content_type,
    fileSize: row.file_size === null || row.file_size === undefined ? undefined : Number(row.file_size),
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

export async function getVideoById(videoId, q = db.query) {
  const { rows } = await q('SELECT * FROM videos WHERE video_id = $1', [videoId]);
  return toVideo(rows[0]);
}

// ---------------- Danh sách

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
  const { rows } = await db.query(
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

// ---------------- Đánh giá

/**
 * Chấm 1-5 sao; chấm lại thì ghi đè. Tổng và số lượt chấm trên videos được tính lại trong cùng
 * transaction, nên luôn khớp với video_ratings.
 */
export async function rateVideo(videoId, userId, stars) {
  return db.withTransaction(async (client) => {
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

export async function getUserRating(videoId, userId) {
  const { rows } = await db.query('SELECT stars FROM video_ratings WHERE video_id = $1 AND user_id = $2', [videoId, userId]);
  return rows[0]?.stars ?? null;
}

// ---------------- Xoá

/** Đánh dấu DELETING có điều kiện: không xoá khi đang PROCESSING (worker có thể đang ghi file) */
export async function markDeleting(videoId) {
  const { rows } = await db.query(
    `UPDATE videos SET status = 'DELETING', updated_at = now()
      WHERE video_id = $1 AND status <> 'PROCESSING' RETURNING *`,
    [videoId]
  );
  if (rows.length === 0) throw new ConflictError('Video đang được transcode, hãy xoá sau khi xử lý xong');
  return toVideo(rows[0]);
}

/** Xoá bản ghi (đánh giá xoá theo) và để lại dấu để bỏ qua sự kiện đến muộn */
export async function deleteVideoRecord(videoId) {
  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM videos WHERE video_id = $1', [videoId]);
    await client.query('INSERT INTO deleted_videos (video_id) VALUES ($1) ON CONFLICT DO NOTHING', [videoId]);
  });
}

export async function isDeleted(videoId, q = db.query) {
  const { rows } = await q('SELECT 1 FROM deleted_videos WHERE video_id = $1', [videoId]);
  return rows.length > 0;
}

// ---------------- Sự kiện

/**
 * Chạy fn trong một transaction, chỉ khi sự kiện chưa được xử lý. Trả về false nếu đã xử lý rồi.
 * fn ném lỗi thì cả việc ghi nhận sự kiện cũng bị huỷ, sự kiện sẽ được xử lý lại.
 */
export async function onceForEvent(event, fn) {
  return db.withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [event.id, event.type]
    );
    if (rowCount === 0) return false;
    await fn((text, params) => client.query(text, params));
    return true;
  });
}

/** Xoá ghi nhận sự kiện cũ hơn 7 ngày (SQS chỉ giao lại trong vài ngày) */
export async function pruneProcessedEvents() {
  const { rowCount } = await db.query("DELETE FROM processed_events WHERE processed_at < now() - interval '7 days'");
  return rowCount;
}

/**
 * VideoCreated / VideoUploaded: tạo hoặc cập nhật video từ thông tin của upload-service.
 * Hai sự kiện có thể đến không theo thứ tự, nên cả hai đều mang đủ thông tin để tạo video.
 * uploaded=true đưa UPLOADING sang PROCESSING; trạng thái đã đi xa hơn thì giữ nguyên.
 */
export async function upsertFromUpload(q, d, { uploaded }) {
  await q(
    `INSERT INTO videos (video_id, title, description, original_file_name, content_type, file_size, owner_id,
                         tier, status, raw_s3_key, raw_bucket, processed_bucket, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()))
     ON CONFLICT (video_id) DO UPDATE SET
       file_size  = COALESCE(EXCLUDED.file_size, videos.file_size),
       status     = CASE WHEN $14 AND videos.status = 'UPLOADING' THEN 'PROCESSING' ELSE videos.status END,
       updated_at = now()`,
    [
      d.videoId,
      d.title || 'Untitled Video',
      d.description || '',
      d.originalFileName ?? null,
      d.contentType || 'video/mp4',
      d.fileSize ?? null,
      d.ownerId ?? null,
      d.tier || 'free',
      uploaded ? 'PROCESSING' : 'UPLOADING',
      d.rawS3Key,
      d.rawBucket,
      d.processedBucket,
      d.createdAt ?? null,
      Boolean(uploaded),
    ]
  );
}

/** Kết quả cập nhật: 'applied', 'missing' (chưa có video), 'ignored' (trạng thái không cho phép) */
async function update(q, videoId, sql, params) {
  const { rowCount } = await q(sql, [videoId, ...params]);
  if (rowCount) return 'applied';
  const exists = await q('SELECT 1 FROM videos WHERE video_id = $1', [videoId]);
  return exists.rowCount ? 'ignored' : 'missing';
}

export function applyTranscodeStarted(q, d) {
  return update(
    q,
    d.videoId,
    `UPDATE videos SET status = 'PROCESSING', attempt = $2, updated_at = now()
      WHERE video_id = $1 AND status IN ('UPLOADING', 'PROCESSING')`,
    [d.attempt ?? 1]
  );
}

export function applyTranscodeCompleted(q, d) {
  return update(
    q,
    d.videoId,
    `UPDATE videos SET status = 'READY', duration = $2, qualities = $3::jsonb, processed_at = $4,
                       last_error = NULL, error_message = NULL, updated_at = now()
      WHERE video_id = $1 AND status <> 'DELETING'`,
    [d.duration ?? null, JSON.stringify(d.qualities || []), d.processedAt || new Date().toISOString()]
  );
}

export function applyTranscodeFailed(q, d) {
  return d.final
    ? update(
        q,
        d.videoId,
        `UPDATE videos SET status = 'FAILED', attempt = $2, error_message = $3, last_error = $3, updated_at = now()
          WHERE video_id = $1 AND status IN ('UPLOADING', 'PROCESSING')`,
        [d.attempt ?? null, d.error || 'Transcode failed']
      )
    : update(
        q,
        d.videoId,
        `UPDATE videos SET attempt = $2, last_error = $3, updated_at = now()
          WHERE video_id = $1 AND status IN ('UPLOADING', 'PROCESSING')`,
        [d.attempt ?? null, d.error || 'Transcode failed']
      );
}

export function applyVideoViewed(q, d) {
  return update(q, d.videoId, 'UPDATE videos SET view_count = view_count + 1 WHERE video_id = $1', []);
}
