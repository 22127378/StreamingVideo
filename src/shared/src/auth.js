// Xác thực dùng chung: mọi service tự kiểm tra access token, không phải gọi sang service account.
//
// Chế độ:
// - cognito: có COGNITO_USER_POOL_ID. Xác minh access token của Cognito (JWKS), gói = group "premium",
//   group "admin" là admin (xem mọi video ở 1080p, quản lý video của mọi người).
// - dev: chạy local không có Cognito. Service account cấp token HS256 ký bằng JWT_SECRET
//   (POST /api/auth/dev-login), mọi service dùng cùng JWT_SECRET để kiểm tra. Ở production chỉ bật
//   khi ALLOW_DEV_AUTH=true (docker compose), và khi đó bắt buộc JWT_SECRET đủ dài.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const DEV_ISSUER = 'StreamForge-Dev';
const DEV_TOKEN_TTL = '12h';

export function resolveAuth(env = process.env) {
  const production = (env.NODE_ENV || 'development') === 'production';
  const userPoolId = env.COGNITO_USER_POOL_ID || '';

  if (userPoolId) {
    const clientId = env.COGNITO_CLIENT_ID;
    if (!clientId) throw new Error('COGNITO_CLIENT_ID is required when COGNITO_USER_POOL_ID is set');
    return {
      mode: 'cognito',
      userPoolId,
      clientId,
      region: userPoolId.split('_')[0],
      domain: env.COGNITO_DOMAIN || '',
      premiumGroup: env.COGNITO_PREMIUM_GROUP || 'premium',
      adminGroup: env.COGNITO_ADMIN_GROUP || 'admin',
    };
  }

  if (production && env.ALLOW_DEV_AUTH !== 'true') {
    throw new Error('COGNITO_USER_POOL_ID is required in production (set ALLOW_DEV_AUTH=true only for local Docker)');
  }
  const secret = env.JWT_SECRET;
  if (production && (!secret || secret.length < 32)) {
    throw new Error('JWT_SECRET phải được cấu hình và dài ít nhất 32 ký tự khi dùng dev auth với NODE_ENV=production');
  }
  return { mode: 'dev', jwtSecret: secret || 'streamforge-local-dev-secret' };
}

export const authConfig = resolveAuth();

let cognitoVerifier;
function verifier() {
  cognitoVerifier ??= CognitoJwtVerifier.create({
    userPoolId: authConfig.userPoolId,
    clientId: authConfig.clientId,
    tokenUse: 'access',
  });
  return cognitoVerifier;
}

/**
 * Xác minh Bearer token và trả về người dùng.
 * @returns {Promise<{ sub: string, username: string, email?: string, tier: 'free' | 'premium', admin: boolean }>}
 */
export async function verifyToken(token) {
  if (authConfig.mode === 'cognito') {
    const payload = await verifier().verify(token);
    const groups = payload['cognito:groups'] || [];
    const admin = groups.includes(authConfig.adminGroup);
    return {
      sub: payload.sub,
      username: payload.username,
      tier: admin || groups.includes(authConfig.premiumGroup) ? 'premium' : 'free',
      admin,
    };
  }

  const payload = jwt.verify(token, authConfig.jwtSecret, { algorithms: ['HS256'], issuer: DEV_ISSUER });
  return { sub: payload.sub, username: payload.email, email: payload.email, tier: payload.tier, admin: false };
}

/** Chỉ ở chế độ dev: cấp token cho một email với gói tuỳ chọn */
export function issueDevToken({ email, tier }) {
  // sub cố định theo email để cùng một người đăng nhập lại vẫn là chủ video cũ
  const sub = `dev-${crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)}`;
  return jwt.sign({ sub, email, tier }, authConfig.jwtSecret, {
    algorithm: 'HS256',
    issuer: DEV_ISSUER,
    expiresIn: DEV_TOKEN_TTL,
  });
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
}

/** Bắt buộc đăng nhập: gắn req.user, thiếu hoặc sai token thì 401 */
export async function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Cần đăng nhập' });
  }
  try {
    req.user = await verifyToken(token);
    return next();
  } catch (err) {
    console.warn(`[HTTP 401] ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(401).json({ success: false, message: 'Phiên đăng nhập hết hạn hoặc không hợp lệ' });
  }
}

/** Không bắt buộc đăng nhập: có token hợp lệ thì gắn req.user, không thì bỏ qua */
export async function optionalAuth(req, res, next) {
  const token = bearer(req);
  if (token) {
    try {
      req.user = await verifyToken(token);
    } catch {
      /* token sai coi như chưa đăng nhập */
    }
  }
  next();
}
