import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { config } from '../config/aws.js';

/**
 * CloudFront signed cookies chỉ mở được HLS của một video, trong một khoảng thời gian.
 * Cookie có Path=/videos/{id}/ nên trình duyệt chỉ gửi chúng khi tải video đó, và nhiều video
 * có thể giữ cookie riêng cùng lúc.
 * @returns {{ cookies: Record<string, string>, path: string, expires: Date } | null}
 *   null khi chưa cấu hình key (chạy local, HLS không bị chặn)
 */
export function signedPlaybackCookies(videoId, now = Date.now()) {
  if (!config.cloudfrontKeyPairId || !config.cloudfrontPrivateKey) return null;

  const { origin, pathname } = new URL(config.cdnBaseUrl);
  const path = `${pathname.replace(/\/+$/, '')}/${videoId}/`;
  const expires = new Date(now + config.playbackCookieTtlSeconds * 1000);
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `${origin}${path}*`,
        Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(expires.getTime() / 1000) } },
      },
    ],
  });

  const cookies = getSignedCookies({
    keyPairId: config.cloudfrontKeyPairId,
    privateKey: config.cloudfrontPrivateKey,
    policy,
  });
  return { cookies, path, expires };
}

/** Người dùng có được xem video này không (theo gói) */
export function canWatch(user, video) {
  return video.tier !== 'premium' || user.tier === 'premium';
}
