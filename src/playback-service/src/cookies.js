import { getSignedCookies } from '@aws-sdk/cloudfront-signer';

/**
 * CloudFront signed cookies chỉ mở được HLS của một video, trong một khoảng thời gian.
 * Cookie có Path=/videos/{id}/ nên trình duyệt chỉ gửi chúng khi tải video đó, và nhiều video
 * có thể giữ cookie riêng cùng lúc.
 * Với hd=false, chính sách chỉ cho /videos/{id}/sd/*: tải file 1080p sẽ bị CloudFront trả 403.
 * @returns {{ cookies: Record<string, string>, path: string, expires: Date } | null}
 *   null khi chưa cấu hình key (chạy local, HLS không bị chặn)
 */
export function signedPlaybackCookies(videoId, { keyPairId, privateKey, cdnBaseUrl, ttlSeconds, hd = true, now = Date.now() }) {
  if (!keyPairId || !privateKey) return null;

  const { origin, pathname } = new URL(cdnBaseUrl);
  const path = `${pathname.replace(/\/+$/, '')}/${videoId}/`;
  const expires = new Date(now + ttlSeconds * 1000);
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `${origin}${path}${hd ? '' : 'sd/'}*`,
        Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(expires.getTime() / 1000) } },
      },
    ],
  });

  return { cookies: getSignedCookies({ keyPairId, privateKey, policy }), path, expires };
}
