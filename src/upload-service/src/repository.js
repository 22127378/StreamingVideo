// Bảng upload.uploads (schema riêng của upload-service).
import { createDb } from '@streamforge/shared/db';
import { ConflictError } from '@streamforge/shared/errors';

export const db = createDb();

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? undefined);

export function toUpload(row) {
  if (!row) return null;
  return {
    videoId: row.video_id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    tier: row.tier,
    originalFileName: row.original_file_name,
    contentType: row.content_type,
    fileSize: Number(row.file_size),
    rawBucket: row.raw_bucket,
    rawS3Key: row.raw_s3_key,
    processedBucket: row.processed_bucket,
    status: row.status,
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
  };
}

export async function createUpload(u) {
  const { rows } = await db.query(
    `INSERT INTO uploads (video_id, owner_id, title, description, tier, original_file_name, content_type,
                          file_size, raw_bucket, raw_s3_key, processed_bucket)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      u.videoId,
      u.ownerId,
      u.title,
      u.description || '',
      u.tier,
      u.originalFileName,
      u.contentType,
      u.fileSize,
      u.rawBucket,
      u.rawS3Key,
      u.processedBucket,
    ]
  );
  return toUpload(rows[0]);
}

export async function getUpload(videoId) {
  const { rows } = await db.query('SELECT * FROM uploads WHERE video_id = $1', [videoId]);
  return toUpload(rows[0]);
}

export async function deleteUpload(videoId) {
  await db.query('DELETE FROM uploads WHERE video_id = $1', [videoId]);
}

/**
 * Đổi trạng thái có điều kiện: chỉ khi đang ở `from`. Hai request /complete cùng lúc thì chỉ một
 * request thắng, request kia nhận ConflictError (409), nên video không bị đưa đi transcode hai lần.
 */
export async function transition(videoId, from, to, { fileSize } = {}) {
  const { rows } = await db.query(
    `UPDATE uploads
        SET status = $3,
            completed_at = CASE WHEN $3 = 'COMPLETED' THEN now() ELSE NULL END,
            file_size = COALESCE($4, file_size)
      WHERE video_id = $1 AND status = $2
      RETURNING *`,
    [videoId, from, to, fileSize ?? null]
  );
  if (rows.length === 0) throw new ConflictError('Upload đã được xác nhận bởi một request khác');
  return toUpload(rows[0]);
}
