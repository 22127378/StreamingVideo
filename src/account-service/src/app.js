// Account service: mọi thứ về người dùng và gói.
//   GET  /api/auth/config     thông tin frontend cần để đăng nhập (không có gì bí mật)
//   POST /api/auth/dev-login  chỉ ở chế độ dev (local, không có Cognito)
//   GET  /api/auth/me         người dùng hiện tại và gói
//   POST /api/auth/upgrade    mô phỏng thanh toán: thêm vào group premium
// Service khác không gọi sang đây: chúng tự kiểm tra token bằng @streamforge/shared/auth.
import { z } from 'zod';
import { AdminAddUserToGroupCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { authConfig, issueDevToken, requireAuth } from '@streamforge/shared/auth';
import { createHttpApp, createRateLimiter } from '@streamforge/shared/http';
import { createMetrics } from '@streamforge/shared/metrics';

export const metrics = createMetrics('account');

const upgrades = new metrics.client.Counter({
  name: 'streamforge_account_upgrades_total',
  help: 'Users upgraded to premium',
  registers: [metrics.registry],
});

const DevLoginSchema = z.object({
  email: z.email('Email không hợp lệ').max(254),
  tier: z.enum(['free', 'premium']).default('free'),
});

let cognito;

/** Thêm người dùng vào group premium. Dev: cấp token mới với tier premium. */
async function upgradeToPremium(user) {
  if (authConfig.mode === 'cognito') {
    cognito ??= new CognitoIdentityProviderClient({ region: authConfig.region });
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: authConfig.userPoolId,
        Username: user.username,
        GroupName: authConfig.premiumGroup,
      })
    );
    // Access token cũ chưa có group mới: frontend phải làm mới token
    return { tier: 'premium', refreshRequired: true };
  }
  return { tier: 'premium', token: issueDevToken({ email: user.email, tier: 'premium' }), refreshRequired: false };
}

function publicAuthConfig() {
  if (authConfig.mode === 'cognito') {
    return {
      mode: 'cognito',
      region: authConfig.region,
      userPoolId: authConfig.userPoolId,
      clientId: authConfig.clientId,
      domain: authConfig.domain,
    };
  }
  return { mode: 'dev' };
}

export function createApp({ rateLimit = {} } = {}) {
  const limit = createRateLimiter({
    max: rateLimit.max ?? parseInt(process.env.RATE_LIMIT_MAX || '30', 10),
    windowSeconds: rateLimit.windowSeconds ?? parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '600', 10),
  });

  return createHttpApp({
    service: 'account',
    metrics,
    routes(app) {
      app.get('/api/auth/config', (req, res) => res.json({ success: true, data: publicAuthConfig() }));

      app.post('/api/auth/dev-login', limit, (req, res, next) => {
        try {
          if (authConfig.mode !== 'dev') {
            return res.status(404).json({ success: false, message: 'Route not found' });
          }
          const { email, tier } = DevLoginSchema.parse(req.body);
          res.json({ success: true, data: { token: issueDevToken({ email, tier }), tier } });
        } catch (err) {
          next(err);
        }
      });

      app.get('/api/auth/me', requireAuth, (req, res) => {
        const { sub, email, tier, admin } = req.user;
        res.json({ success: true, data: { sub, email, tier, admin } });
      });

      app.post('/api/auth/upgrade', limit, requireAuth, async (req, res, next) => {
        try {
          if (req.user.tier === 'premium') {
            return res.json({ success: true, data: { tier: 'premium', refreshRequired: false } });
          }
          const result = await upgradeToPremium(req.user);
          upgrades.inc();
          res.json({ success: true, message: 'Đã nâng lên Premium', data: result });
        } catch (err) {
          next(err);
        }
      });
    },
  });
}
