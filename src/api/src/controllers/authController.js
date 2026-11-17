import { z } from 'zod';
import { config } from '../config/aws.js';
import { issueDevToken, publicAuthConfig, upgradeToPremium } from '../services/authService.js';

const DevLoginSchema = z.object({
  email: z.email('Email không hợp lệ').max(254),
  tier: z.enum(['free', 'premium']).default('free'),
});

/**
 * [GET /api/auth/config]
 * Frontend đọc để biết đăng nhập bằng Cognito (redirect) hay form dev
 */
export function getAuthConfig(req, res) {
  res.status(200).json({ success: true, data: publicAuthConfig() });
}

/**
 * [POST /api/auth/dev-login] chỉ có ở chế độ dev (local, không có Cognito)
 */
export function devLogin(req, res, next) {
  try {
    if (config.auth.mode !== 'dev') {
      return res.status(404).json({ success: false, message: 'Route not found' });
    }
    const { email, tier } = DevLoginSchema.parse(req.body);
    res.status(200).json({ success: true, data: { token: issueDevToken({ email, tier }), tier } });
  } catch (error) {
    next(error);
  }
}

/**
 * [GET /api/auth/me] người dùng hiện tại và gói của họ
 */
export function getMe(req, res) {
  const { sub, email, tier, admin } = req.user;
  res.status(200).json({ success: true, data: { sub, email, tier, admin } });
}

/**
 * [POST /api/auth/upgrade]
 * Mô phỏng thanh toán thành công: đưa người dùng lên Premium.
 * Với Cognito, client phải refresh token để access token có group mới.
 */
export async function upgrade(req, res, next) {
  try {
    if (req.user.tier === 'premium') {
      return res.status(200).json({ success: true, data: { tier: 'premium', refreshRequired: false } });
    }
    const result = await upgradeToPremium(req.user);
    res.status(200).json({ success: true, message: 'Đã nâng lên Premium', data: result });
  } catch (error) {
    next(error);
  }
}
