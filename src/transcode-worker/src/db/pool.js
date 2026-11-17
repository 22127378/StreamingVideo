// Kết nối PostgreSQL (Aurora Serverless v2 trên AWS, postgres thường khi chạy local).
//
// Trên AWS: DB_IAM_AUTH=true, mật khẩu là token IAM 15 phút sinh từ credentials Pod Identity cho từng
// kết nối mới (pg gọi hàm password mỗi lần mở kết nối). Bắt buộc TLS và kiểm tra chứng chỉ RDS.
// Local: DB_PASSWORD thường, DB_SSL=false.
import fs from 'node:fs';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const env = process.env;

export const dbConfig = {
  host: env.DB_HOST || 'localhost',
  port: parseInt(env.DB_PORT || '5432', 10),
  database: env.DB_NAME || 'streamforge',
  user: env.DB_USER || 'streamforge',
  iamAuth: env.DB_IAM_AUTH === 'true',
  ssl: env.DB_SSL === 'true',
  sslCaPath: env.DB_SSL_CA || '/app/certs/rds-global-bundle.pem',
  region: env.AWS_REGION || 'us-east-1',
};

function passwordProvider() {
  if (!dbConfig.iamAuth) return env.DB_PASSWORD || 'streamforge';
  const signer = new Signer({
    hostname: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.user,
    region: dbConfig.region,
  });
  return () => signer.getAuthToken();
}

function sslOptions() {
  if (!dbConfig.ssl) return false;
  // Chứng chỉ RDS không nằm trong kho CA mặc định của Node; image Docker kèm bundle của AWS
  const ca = fs.existsSync(dbConfig.sslCaPath) ? fs.readFileSync(dbConfig.sslCaPath, 'utf8') : undefined;
  return { rejectUnauthorized: true, ca };
}

export const pool = new pg.Pool({
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  password: passwordProvider(),
  ssl: sslOptions(),
  max: parseInt(env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Lỗi trên kết nối đang rảnh (ví dụ Aurora failover) không được làm sập process
pool.on('error', (err) => console.error('[DB] idle client error', err));

export const query = (text, params) => pool.query(text, params);
