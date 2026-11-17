import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from '../config/aws.js';

const DEV_ISSUER = 'StreamForge-Dev';
const DEV_TOKEN_TTL = '12h';

let cognitoVerifier;
let cognitoClient;

function verifier() {
  cognitoVerifier ??= CognitoJwtVerifier.create({
    userPoolId: config.auth.userPoolId,
    clientId: config.auth.clientId,
    tokenUse: 'access',
  });
  return cognitoVerifier;
}

/**
 * Xác minh Bearer token và trả về người dùng.
 * @returns {Promise<{ sub: string, username: string, email?: string, tier: 'free' | 'premium' }>}
 */
export async function verifyToken(token) {
  if (config.auth.mode === 'cognito') {
    const payload = await verifier().verify(token);
    const groups = payload['cognito:groups'] || [];
    const admin = groups.includes(config.auth.adminGroup);
    return {
      sub: payload.sub,
      username: payload.username,
      // Admin xem được mọi video và quản lý video của mọi người
      tier: admin || groups.includes(config.auth.premiumGroup) ? 'premium' : 'free',
      admin,
    };
  }

  const payload = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'], issuer: DEV_ISSUER });
  return { sub: payload.sub, username: payload.email, email: payload.email, tier: payload.tier, admin: false };
}

/** Chỉ ở chế độ dev: cấp token cho một email với gói tuỳ chọn */
export function issueDevToken({ email, tier }) {
  // sub cố định theo email để cùng một người đăng nhập lại vẫn là chủ video cũ
  const sub = `dev-${crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)}`;
  return jwt.sign({ sub, email, tier }, config.auth.jwtSecret, {
    algorithm: 'HS256',
    issuer: DEV_ISSUER,
    expiresIn: DEV_TOKEN_TTL,
  });
}

/**
 * Nâng người dùng lên Premium (mô phỏng thanh toán thành công).
 * Cognito: thêm vào group premium; frontend phải refresh token để nhận claim mới.
 * Dev: cấp token mới với tier premium.
 * @returns {Promise<{ tier: 'premium', token?: string, refreshRequired: boolean }>}
 */
export async function upgradeToPremium(user) {
  if (config.auth.mode === 'cognito') {
    cognitoClient ??= new CognitoIdentityProviderClient({ region: config.auth.region });
    await cognitoClient.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: config.auth.userPoolId,
        Username: user.username,
        GroupName: config.auth.premiumGroup,
      })
    );
    return { tier: 'premium', refreshRequired: true };
  }
  return { tier: 'premium', token: issueDevToken({ email: user.email, tier: 'premium' }), refreshRequired: false };
}

/** Thông tin frontend cần để đăng nhập (không có gì bí mật) */
export function publicAuthConfig() {
  if (config.auth.mode === 'cognito') {
    return {
      mode: 'cognito',
      region: config.auth.region,
      userPoolId: config.auth.userPoolId,
      clientId: config.auth.clientId,
      domain: config.auth.domain,
    };
  }
  return { mode: 'dev' };
}
