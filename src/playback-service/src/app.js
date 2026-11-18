// Playback service: không có database riêng.
//   POST /api/playback/:id   kiểm tra quyền xem, đặt CloudFront signed cookies, phát VideoViewed
// Thông tin video (chủ, gói, trạng thái, các mức chất lượng) lấy từ catalog qua API nội bộ trong cụm.
import { z } from 'zod';
import { canWatch, canWatchHd, FREE_MAX_HEIGHT, qualityHeight } from '@streamforge/shared/access';
import { requireAuth } from '@streamforge/shared/auth';
import { HttpError } from '@streamforge/shared/errors';
import { EVENT_TYPES, publishEvent } from '@streamforge/shared/events';
import { createHttpApp } from '@streamforge/shared/http';
import { createMetrics } from '@streamforge/shared/metrics';
import { signedPlaybackCookies } from './cookies.js';

const env = process.env;
export const config = {
  catalogUrl: env.CATALOG_URL || 'http://localhost:4003',
  cdnBaseUrl: env.CDN_BASE_URL || 'http://localhost:4566/streamforge-processed',
  keyPairId: env.CLOUDFRONT_KEY_PAIR_ID || '',
  privateKey: (env.CLOUDFRONT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ttlSeconds: parseInt(env.PLAYBACK_COOKIE_TTL_SECONDS || '7200', 10),
};

export const metrics = createMetrics('playback');
const decisions = new metrics.client.Counter({
  name: 'streamforge_playback_decisions_total',
  help: 'Playback requests by result (allowed, denied_tier, not_ready, not_found)',
  labelNames: ['result', 'video_tier', 'user_tier'],
  registers: [metrics.registry],
});

const IdSchema = z.object({ id: z.uuid('VideoId không hợp lệ') });

/** Hỏi catalog thông tin video. null nếu không có. */
export async function fetchVideo(videoId, { catalogUrl = config.catalogUrl, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${catalogUrl}/internal/videos/${videoId}`, { signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(503, 'Không lấy được thông tin video, thử lại sau');
  return (await res.json()).data;
}

export function createApp({ getVideo = fetchVideo, publish = publishEvent } = {}) {
  return createHttpApp({
    service: 'playback',
    metrics,
    routes(app) {
      app.post('/api/playback/:id', requireAuth, async (req, res, next) => {
        try {
          const { id } = IdSchema.parse(req.params);
          const video = await getVideo(id);
          const decision = (result) => decisions.inc({ result, video_tier: video?.tier || 'unknown', user_tier: req.user.tier });
          if (!video) {
            decision('not_found');
            throw new HttpError(404, `Video not found with ID: ${id}`);
          }
          if (video.status !== 'READY') {
            decision('not_ready');
            throw new HttpError(409, `Video chưa sẵn sàng để phát (trạng thái ${video.status})`, { currentStatus: video.status });
          }
          if (!canWatch(req.user, video)) {
            decision('denied_tier');
            throw new HttpError(403, 'Video dành cho gói Premium', { requiredTier: 'premium', userTier: req.user.tier });
          }

          decision('allowed');
          // Video transcode theo bố cục sd/ + hd/ thì giới hạn 720p cho gói Free bằng chính sách cookie.
          // Video cũ (file phẳng, không có q.path) chưa tách được nên mở toàn bộ.
          const tiered = video.qualities.some((q) => q.path);
          const hd = canWatchHd(req.user) || !tiered;
          const signed = signedPlaybackCookies(id, { ...config, hd });
          if (signed) {
            for (const [name, value] of Object.entries(signed.cookies)) {
              res.cookie(name, value, { path: signed.path, expires: signed.expires, secure: true, httpOnly: true, sameSite: 'lax' });
            }
          }

          // Lượt xem là phụ: phát lỗi thì vẫn cho xem
          publish('playback', EVENT_TYPES.VideoViewed, { videoId: id, userId: req.user.sub }).catch((err) =>
            console.warn(`[playback] VideoViewed not published for ${id}: ${err.message}`)
          );

          const base = `${config.cdnBaseUrl}/${id}`;
          res.json({
            success: true,
            data: {
              streamingUrl: hd ? `${base}/master.m3u8` : `${base}/sd/master.m3u8`,
              maxHeight: hd ? null : FREE_MAX_HEIGHT,
              lockedQualities: hd
                ? []
                : video.qualities.filter((q) => qualityHeight(q.resolution) > FREE_MAX_HEIGHT).map((q) => q.resolution),
              expiresAt: signed?.expires.toISOString() ?? null,
              signedCookies: Boolean(signed),
            },
          });
        } catch (err) {
          next(err);
        }
      });
    },
  });
}
