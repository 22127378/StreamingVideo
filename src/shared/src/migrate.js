// Migration database cho một service. Chạy bằng tài khoản master (Job migration trên EKS, hoặc
// service migrate-* của docker compose):
//   1. Tạo schema của service và bảng schema_migrations trong schema đó.
//   2. Áp các file migrations/*.sql chưa chạy, mỗi file trong một transaction (search_path = schema).
//   3. Tạo user của service, chỉ có quyền trên schema của mình (database-per-service ở mức schema).
//      Trên Aurora, gán rds_iam để đăng nhập bằng token IAM; local đặt mật khẩu DB_PASSWORD.
//
// Mật khẩu master lấy từ DB_MASTER_SECRET_ARN (Secrets Manager, RDS quản lý) hoặc
// DB_MASTER_USER + DB_MASTER_PASSWORD (local).
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { awsClientConfig } from './aws.js';
import { dbConfigFromEnv, sslOptions } from './db.js';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const MIGRATION_LOCK_ID = 7_384_201; // số bất kỳ, chung cho mọi service

async function masterCredentials(env) {
  if (env.DB_MASTER_SECRET_ARN) {
    const client = new SecretsManagerClient(awsClientConfig);
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: env.DB_MASTER_SECRET_ARN }));
    const secret = JSON.parse(SecretString);
    return { user: secret.username, password: secret.password };
  }
  return { user: env.DB_MASTER_USER || 'streamforge', password: env.DB_MASTER_PASSWORD || 'streamforge' };
}

/** Kết nối bằng tài khoản master */
export async function connectAsMaster(env = process.env) {
  const cfg = dbConfigFromEnv(env);
  const { user, password } = await masterCredentials(env);
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user,
    password,
    ssl: sslOptions(cfg),
    connectionTimeoutMillis: cfg.connectTimeoutMs,
  });
  await client.connect();
  return client;
}

async function applyMigrations(client, schema, dir, log) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await client.query(`SELECT name FROM ${schema}.schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL search_path = ${schema}`);
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query(`INSERT INTO ${schema}.schema_migrations (name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      log(`applied ${schema}/${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${schema}/${file} failed: ${err.message}`);
    }
  }
}

async function ensureServiceUser(client, { schema, user, database, password, log }) {
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'");
  const onAurora = rows.length > 0;
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
  // Tên user và schema đã kiểm tra bằng IDENT, nên ghép vào SQL được
  if (exists.rows.length === 0) await client.query(`CREATE ROLE ${user} LOGIN`);
  if (onAurora) {
    await client.query(`GRANT rds_iam TO ${user}`);
  } else {
    await client.query(`ALTER ROLE ${user} PASSWORD '${password.replace(/'/g, "''")}'`);
  }
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${user}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${user}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${user}`);
  // Không cho service đọc bảng migration
  await client.query(`REVOKE ALL ON ${schema}.schema_migrations FROM ${user}`);
  log(`user ${user} ready on schema ${schema} (${onAurora ? 'IAM auth' : 'password auth'})`);
}

/**
 * @param {{ schema: string, user: string, dir: string, afterMigrate?: (client) => Promise<void>, env?: object }} options
 *   afterMigrate: bước thêm sau migration (ví dụ chuyển dữ liệu cũ, tạo số liệu mẫu), chạy bằng master.
 */
export async function runMigrations({ schema, user, dir, afterMigrate, env = process.env }) {
  if (!IDENT.test(schema) || !IDENT.test(user)) throw new Error('schema/user không hợp lệ');
  const log = (msg) => console.log(`[migrate] ${msg}`);
  const cfg = dbConfigFromEnv(env);
  const client = await connectAsMaster(env);
  try {
    // Job migration của các service chạy song song; GRANT trên cùng database cùng lúc làm PostgreSQL
    // báo "tuple concurrently updated". Khoá advisory để chúng chạy lần lượt (tự nhả khi ngắt kết nối).
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await applyMigrations(client, schema, dir, log);
    await ensureServiceUser(client, { schema, user, database: cfg.database, password: cfg.password, log });
    if (afterMigrate) await afterMigrate(client, log);
  } finally {
    await client.end();
  }
}
