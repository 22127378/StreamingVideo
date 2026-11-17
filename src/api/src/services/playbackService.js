import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { config } from '../config/aws.js';

// Gói Free xem tối đa 720p. Worker ghi biến thể cao hơn vào {id}/hd/, còn lại vào {id}/sd/
// kèm sd/master.m3u8 chỉ chứa biến thể tới 720p. Phải khớp FREE_MAX_HEIGHT của transcode-worker.
export const FREE_MAX_HEIGHT = 720;

/** Người dùng xem được bản trên 720p không: Premium và admin được, Free thì không */
export function canWatchHd(user) {
  return user.tier === 'premium' || Boolean(user.admin);
}

/**
 * Người dùng có được xem video này không.
 * - Video Free: ai đăng nhập cũng xem được.
 * - Video Premium: người dùng Premium, admin, và chủ video (người upload luôn xem được video của mình).
 */
export function canWatch(user, video) {
  if (video.tier !== 'premium') return true;
  return canWatchHd(user) || (Boolean(video.ownerId) && video.ownerId === user.sub);
}

/**
 * CloudFront signed cookies chỉ mở được HLS của một video, trong một khoảng thời gian.
 * Cookie có Path=/videos/{id}/ nên trình duyệt chỉ gửi chúng khi tải video đó, và nhiều video
 * có thể giữ cookie riêng cùng lúc.
 * Với hd=false, chính sách chỉ cho /videos/{id}/sd/*: tải file 1080p sẽ bị CloudFront trả 403.
 * @returns {{ cookies: Record<string, string>, path: string, expires: Date } | null}
 *   null khi chưa cấu hình key (chạy local, HLS không bị chặn)
 */
export function signedPlaybackCookies(videoId, { hd = true, now = Date.now() } = {}) {
  if (!config.cloudfrontKeyPairId || !config.cloudfrontPrivateKey) return null;

  const { origin, pathname } = new URL(config.cdnBaseUrl);
  const path = `${pathname.replace(/\/+$/, '')}/${videoId}/`;
  const expires = new Date(now + config.playbackCookieTtlSeconds * 1000);
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `${origin}${path}${hd ? '' : 'sd/'}*`,
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

/** Chiều cao (cạnh ngắn) của một mức chất lượng, ví dụ '1080p' -> 1080 */
export const qualityHeight = (resolution) => parseInt(resolution, 10) || 0;
