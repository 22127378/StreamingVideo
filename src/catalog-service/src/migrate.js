// Migration schema "catalog" và user streamforge_catalog. Chạy bằng Job migration (tài khoản master).
// Sau migration:
//   - Thu hồi quyền của user cũ (streamforge_api, streamforge_worker) trên bảng đã chuyển sang catalog:
//     chỉ catalog-service được đọc/ghi dữ liệu của mình.
//   - SEED_DEMO_STATS=true: tạo lượt xem và đánh giá mẫu cho video READY chưa có số liệu nào
//     (đánh giá mẫu có user_id bắt đầu bằng "demo:").
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@streamforge/shared/migrate';

// Số giả ngẫu nhiên ổn định theo videoId: chạy lại cho cùng kết quả
function seeded(videoId) {
  let h = 2166136261;
  for (const ch of videoId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h ^= h >>> 16; // ^ trả về số có dấu
    return (h >>> 0) / 4294967296; // đưa về [0, 1)
  };
}

async function seedDemoStats(client, log) {
  const { rows } = await client.query(
    `SELECT video_id, tier FROM catalog.videos WHERE status = 'READY' AND view_count = 0 AND rating_count = 0`
  );
  for (const { video_id: id, tier } of rows) {
    const rand = seeded(id);
    // Video Premium ít lượt xem hơn nhưng điểm nhỉnh hơn
    const views = Math.floor((tier === 'premium' ? 40 : 120) + rand() * (tier === 'premium' ? 400 : 1500));
    const raters = 3 + Math.floor(rand() * 25);
    const bias = tier === 'premium' ? 0.6 : 0;
    await client.query('BEGIN');
    try {
      for (let i = 0; i < raters; i++) {
        const stars = Math.max(1, Math.min(5, Math.round(2.6 + bias + rand() * 2.6)));
        await client.query(
          `INSERT INTO catalog.video_ratings (video_id, user_id, stars) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [id, `demo:viewer-${i + 1}`, stars]
        );
      }
      await client.query(
        `UPDATE catalog.videos v SET view_count = $2, rating_sum = r.sum, rating_count = r.count
         FROM (SELECT coalesce(sum(stars), 0)::int AS sum, count(*)::int AS count
               FROM catalog.video_ratings WHERE video_id = $1) r
         WHERE v.video_id = $1`,
        [id, views]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  log(`seeded demo views and ratings for ${rows.length} videos`);
}

async function revokeLegacyUsers(client, log) {
  const { rows } = await client.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('streamforge_api', 'streamforge_worker')"
  );
  for (const { rolname } of rows) {
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA catalog FROM ${rolname}`);
  }
  if (rows.length) log(`revoked catalog access from ${rows.map((r) => r.rolname).join(', ')}`);
}

runMigrations({
  schema: 'catalog',
  user: 'streamforge_catalog',
  dir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
  async afterMigrate(client, log) {
    await revokeLegacyUsers(client, log);
    if (process.env.SEED_DEMO_STATS === 'true') await seedDemoStats(client, log);
  },
}).catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
