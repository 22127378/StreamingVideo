// Bảng của live (schema live): channels, subscriptions, chat_messages.
import { createDb } from '@streamforge/shared/db';

export const db = createDb();

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? undefined);

export function toChannel(row) {
  if (!row) return null;
  return {
    channelId: row.channel_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    title: row.title,
    provider: row.provider,
    providerChannelId: row.provider_channel_id,
    ingestEndpoint: row.ingest_endpoint,
    playbackUrl: row.playback_url,
    streamKeyRef: row.stream_key_ref,
    subscriberCount: row.subscriber_count ?? 0,
    // Chỉ có khi truy vấn kèm người xem
    subscribed: row.subscribed ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toMessage(row) {
  return {
    messageId: Number(row.message_id),
    userId: row.user_id,
    userName: row.user_name,
    body: row.body,
    subscriber: Boolean(row.subscriber),
    owner: row.user_id === row.owner_id,
    createdAt: iso(row.created_at),
  };
}

// subscribed của người xem $1 (NULL khi chưa đăng nhập thì luôn false)
const CHANNEL_COLUMNS = `c.*, EXISTS (
  SELECT 1 FROM subscriptions s WHERE s.channel_id = c.channel_id AND s.user_id = $1
) AS subscribed`;

export async function listChannels({ viewerId = null, limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT ${CHANNEL_COLUMNS} FROM channels c ORDER BY c.subscriber_count DESC, c.created_at DESC LIMIT $2`,
    [viewerId, limit]
  );
  return rows.map(toChannel);
}

export async function getChannel(channelId, viewerId = null) {
  const { rows } = await db.query(`SELECT ${CHANNEL_COLUMNS} FROM channels c WHERE c.channel_id = $2`, [
    viewerId,
    channelId,
  ]);
  return toChannel(rows[0]);
}

export async function getChannelByOwner(ownerId) {
  const { rows } = await db.query('SELECT * FROM channels WHERE owner_id = $1', [ownerId]);
  return toChannel(rows[0]);
}

/** Tạo kênh; người này đã có kênh (2 request cùng lúc) thì trả null */
export async function insertChannel(c) {
  const { rows } = await db.query(
    `INSERT INTO channels (channel_id, owner_id, owner_name, title, provider, provider_channel_id,
                           ingest_endpoint, playback_url, stream_key_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (owner_id) DO NOTHING
     RETURNING *`,
    [
      c.channelId,
      c.ownerId,
      c.ownerName,
      c.title,
      c.provider,
      c.providerChannelId,
      c.ingestEndpoint,
      c.playbackUrl,
      c.streamKeyRef,
    ]
  );
  return toChannel(rows[0]);
}

export async function updateChannel(channelId, { title, ownerName, streamKeyRef }) {
  const { rows } = await db.query(
    `UPDATE channels SET
       title          = coalesce($2, title),
       owner_name     = coalesce($3, owner_name),
       stream_key_ref = coalesce($4, stream_key_ref),
       updated_at     = now()
     WHERE channel_id = $1 RETURNING *`,
    [channelId, title ?? null, ownerName ?? null, streamKeyRef ?? null]
  );
  return toChannel(rows[0]);
}

/** Đăng ký / huỷ đăng ký; trả số người đăng ký mới. Lặp lại không đổi gì (idempotent). */
export async function setSubscription(channelId, userId, subscribed) {
  return db.withTransaction(async (client) => {
    const changed = subscribed
      ? await client.query(
          'INSERT INTO subscriptions (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1',
          [channelId, userId]
        )
      : await client.query('DELETE FROM subscriptions WHERE channel_id = $1 AND user_id = $2 RETURNING 1', [
          channelId,
          userId,
        ]);
    const delta = changed.rowCount ? (subscribed ? 1 : -1) : 0;
    const { rows } = await client.query(
      'UPDATE channels SET subscriber_count = subscriber_count + $2 WHERE channel_id = $1 RETURNING subscriber_count',
      [channelId, delta]
    );
    return rows[0].subscriber_count;
  });
}

/** Lưu bình luận, trả về kèm huy hiệu (người đăng ký, chủ kênh) */
export async function addMessage({ channelId, userId, userName, body }) {
  const { rows } = await db.query(
    `WITH m AS (
       INSERT INTO chat_messages (channel_id, user_id, user_name, body) VALUES ($1, $2, $3, $4) RETURNING *
     )
     SELECT m.*, c.owner_id,
            EXISTS (SELECT 1 FROM subscriptions s WHERE s.channel_id = m.channel_id AND s.user_id = m.user_id) AS subscriber
     FROM m JOIN channels c ON c.channel_id = m.channel_id`,
    [channelId, userId, userName, body]
  );
  return toMessage(rows[0]);
}

/**
 * Bình luận của kênh. Không có after: `limit` bình luận mới nhất. Có after: các bình luận có id lớn
 * hơn (trình duyệt hỏi định kỳ). Luôn trả theo thứ tự cũ -> mới.
 */
export async function listMessages(channelId, { after, limit = 50 } = {}) {
  const select = `SELECT m.*, c.owner_id, (s.user_id IS NOT NULL) AS subscriber
    FROM chat_messages m
    JOIN channels c ON c.channel_id = m.channel_id
    LEFT JOIN subscriptions s ON s.channel_id = m.channel_id AND s.user_id = m.user_id
    WHERE m.channel_id = $1`;
  const { rows } =
    after === undefined
      ? await db.query(`SELECT * FROM (${select} ORDER BY m.message_id DESC LIMIT $2) t ORDER BY message_id`, [
          channelId,
          limit,
        ])
      : await db.query(`${select} AND m.message_id > $2 ORDER BY m.message_id LIMIT $3`, [channelId, after, limit]);
  return rows.map(toMessage);
}

/** Chủ kênh (hoặc admin) xoá bình luận trong kênh */
export async function deleteMessage(channelId, messageId) {
  const { rowCount } = await db.query('DELETE FROM chat_messages WHERE channel_id = $1 AND message_id = $2', [
    channelId,
    messageId,
  ]);
  return rowCount > 0;
}

export async function pruneMessages(days) {
  const { rowCount } = await db.query('DELETE FROM chat_messages WHERE created_at < now() - make_interval(days => $1)', [
    days,
  ]);
  return rowCount;
}
