// Kết nối PostgreSQL (Aurora Serverless v2 trên AWS, postgres thường khi chạy local).
//
// Mỗi service có user riêng và chỉ thấy schema của mình (search_path = schema đó).
// Trên AWS: DB_IAM_AUTH=true, mật khẩu là token IAM 15 phút sinh từ credentials Pod Identity cho từng
// kết nối mới. Bắt buộc TLS và kiểm tra chứng chỉ RDS. Local: DB_PASSWORD thường, DB_SSL=false.
import fs from 'node:fs';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

export function dbConfigFromEnv(env = process.env) {
  return {
    host: env.DB_HOST || 'localhost',
    port: parseInt(env.DB_PORT || '5432', 10),
    database: env.DB_NAME || 'streamforge',
    user: env.DB_USER || 'streamforge',
    schema: env.DB_SCHEMA || 'public',
    iamAuth: env.DB_IAM_AUTH === 'true',
    ssl: env.DB_SSL === 'true',
    sslCaPath: env.DB_SSL_CA || '/app/certs/rds-global-bundle.pem',
    region: env.AWS_REGION || 'us-east-1',
    password: env.DB_PASSWORD || 'streamforge',
    poolMax: parseInt(env.DB_POOL_MAX || '10', 10),
    // Aurora tự dừng khi rảnh (min_capacity = 0): kết nối đầu tiên chờ database thức dậy, thường ~15s
    connectTimeoutMs: parseInt(env.DB_CONNECT_TIMEOUT_MS || '40000', 10),
  };
}

export function sslOptions(cfg) {
  if (!cfg.ssl) return false;
  // Chứng chỉ RDS không nằm trong kho CA mặc định của Node; image Docker kèm bundle của AWS
  const ca = fs.existsSync(cfg.sslCaPath) ? fs.readFileSync(cfg.sslCaPath, 'utf8') : undefined;
  return { rejectUnauthorized: true, ca };
}

/**
 * @returns {{ pool: pg.Pool, query: Function, withTransaction: Function, config: object }}
 */
export function createDb(cfg = dbConfigFromEnv()) {
  const password = cfg.iamAuth
    ? (() => {
        const signer = new Signer({ hostname: cfg.host, port: cfg.port, username: cfg.user, region: cfg.region });
        return () => signer.getAuthToken();
      })()
    : cfg.password;

  const pool = new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password,
    ssl: sslOptions(cfg),
    max: cfg.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: cfg.connectTimeoutMs,
    // Tên bảng trong code không ghi schema: mỗi service chỉ làm việc trong schema của mình
    options: `-c search_path=${cfg.schema}`,
  });

  // Lỗi trên kết nối đang rảnh (ví dụ Aurora failover) không được làm sập process
  pool.on('error', (err) => console.error('[DB] idle client error', err));

  const query = (text, params) => pool.query(text, params);

  /** Chạy fn(client) trong một transaction; lỗi thì ROLLBACK và ném lại */
  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { pool, query, withTransaction, config: cfg };
}
