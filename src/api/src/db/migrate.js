// Migration database. Chạy bằng tài khoản master (Job k8s/db/migrate-job.yaml, hoặc service "migrate"
// của docker compose khi chạy local):
//   1. Áp các file migrations/*.sql chưa chạy, mỗi file trong một transaction.
//   2. Tạo user cho từng service với quyền tối thiểu: streamforge_api (đọc/ghi/xoá videos và
//      video_ratings), streamforge_worker (đọc/cập nhật videos). Trên Aurora, gán rds_iam để đăng nhập bằng token IAM.
//   3. Nếu có IMPORT_DYNAMODB_TABLE: chép video từ bảng DynamoDB cũ (bỏ qua bản ghi đã có).
//   4. Nếu SEED_DEMO_STATS=true: tạo lượt xem và đánh giá mẫu cho video READY chưa có số liệu nào,
//      để trang chính có dữ liệu sắp xếp khi demo. Đánh giá mẫu có user_id bắt đầu bằng "demo:".
//
// Biến môi trường: DB_HOST, DB_PORT, DB_NAME, DB_SSL; mật khẩu master lấy từ DB_MASTER_SECRET_ARN
// (Secrets Manager, RDS quản lý) hoặc DB_MASTER_USER + DB_MASTER_PASSWORD (local).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, paginateScan } from '@aws-sdk/lib-dynamodb';
import { dbConfig } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// user -> { bảng: quyền }
const SERVICE_USERS = {
  streamforge_api: {
    videos: 'SELECT, INSERT, UPDATE, DELETE',
    video_ratings: 'SELECT, INSERT, UPDATE, DELETE',
  },
  streamforge_worker: { videos: 'SELECT, UPDATE' },
};

async function masterCredentials() {
  if (process.env.DB_MASTER_SECRET_ARN) {
    const client = new SecretsManagerClient({ region: dbConfig.region });
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: process.env.DB_MASTER_SECRET_ARN }));
    const secret = JSON.parse(SecretString);
    return { user: secret.username, password: secret.password };
  }
  return { user: process.env.DB_MASTER_USER || 'streamforge', password: process.env.DB_MASTER_PASSWORD || 'streamforge' };
}

async function applyMigrations(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
}

async function ensureServiceUsers(client) {
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'");
  const onAurora = rows.length > 0;
  for (const [user, grants] of Object.entries(SERVICE_USERS)) {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    if (exists.rows.length === 0) {
      // Tên user cố định trong code (không từ input), nên ghép vào SQL được
      await client.query(`CREATE ROLE ${user} LOGIN`);
    }
    if (onAurora) {
      await client.query(`GRANT rds_iam TO ${user}`);
    } else {
      // Local không có IAM: dùng cùng mật khẩu với master cho tiện
      await client.query(`ALTER ROLE ${user} PASSWORD '${(process.env.DB_PASSWORD || 'streamforge').replace(/'/g, "''")}'`);
    }
    await client.query(`GRANT CONNECT ON DATABASE ${dbConfig.database} TO ${user}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
    for (const [table, privileges] of Object.entries(grants)) {
      await client.query(`GRANT ${privileges} ON ${table} TO ${user}`);
    }
  }
  console.log(`[migrate] service users ready (${onAurora ? 'IAM auth' : 'password auth'})`);
}

async function importFromDynamoDB(client, table) {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: dbConfig.region }));
  let imported = 0;
  let skipped = 0;
  for await (const page of paginateScan({ client: ddb }, { TableName: table })) {
    for (const v of page.Items || []) {
      const { rowCount } = await client.query(
        `INSERT INTO videos (video_id, title, description, original_file_name, content_type, file_size, owner_id,
                             tier, status, raw_s3_key, raw_bucket, processed_bucket, duration, qualities, attempt,
                             last_error, error_message, created_at, updated_at, processed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (video_id) DO NOTHING`,
        [
          v.videoId, v.title || 'Untitled Video', v.description || '', v.originalFileName ?? null,
          v.contentType || 'video/mp4', v.fileSize ?? null, v.ownerId ?? null, v.tier || 'free',
          v.status, v.rawS3Key, v.rawBucket, v.processedBucket, v.duration ?? null,
          v.qualities ? JSON.stringify(v.qualities) : null, v.attempt ?? null, v.lastError ?? null,
          v.errorMessage ?? null, v.createdAt, v.updatedAt || v.createdAt, v.processedAt ?? null,
        ]
      );
      if (rowCount) imported += 1;
      else skipped += 1;
    }
  }
  console.log(`[migrate] imported ${imported} videos from DynamoDB ${table} (${skipped} already present)`);
}

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

async function seedDemoStats(client) {
  const { rows } = await client.query(
    `SELECT video_id, tier FROM videos
     WHERE status = 'READY' AND view_count = 0 AND rating_count = 0`
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
          `INSERT INTO video_ratings (video_id, user_id, stars) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, `demo:viewer-${i + 1}`, stars]
        );
      }
      await client.query(
        `UPDATE videos v SET view_count = $2, rating_sum = r.sum, rating_count = r.count
         FROM (SELECT coalesce(sum(stars), 0)::int AS sum, count(*)::int AS count
               FROM video_ratings WHERE video_id = $1) r
         WHERE v.video_id = $1`,
        [id, views]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  console.log(`[migrate] seeded demo views and ratings for ${rows.length} videos`);
}

async function main() {
  const { user, password } = await masterCredentials();
  const client = new pg.Client({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user,
    password,
    ssl: dbConfig.ssl
      ? { rejectUnauthorized: true, ca: fs.existsSync(dbConfig.sslCaPath) ? fs.readFileSync(dbConfig.sslCaPath, 'utf8') : undefined }
      : false,
  });
  await client.connect();
  try {
    await applyMigrations(client);
    await ensureServiceUsers(client);
    if (process.env.IMPORT_DYNAMODB_TABLE) await importFromDynamoDB(client, process.env.IMPORT_DYNAMODB_TABLE);
    if (process.env.SEED_DEMO_STATS === 'true') await seedDemoStats(client);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
