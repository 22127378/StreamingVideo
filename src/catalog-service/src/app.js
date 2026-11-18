// Catalog service: thông tin video cho người xem.
//   GET    /api/videos              danh sách (lọc theo trạng thái, gói, thời gian; sắp xếp)
//   GET    /api/videos/mine         video của người đang đăng nhập, mọi trạng thái
//   GET    /api/videos/:id          chi tiết (+ số sao mình đã chấm nếu đăng nhập)
//   PUT    /api/videos/:id/rating   chấm 1-5 sao
//   DELETE /api/videos/:id          xoá video (chủ video hoặc admin)
//   GET    /internal/videos/:id     cho playback-service trong cụm; Ingress không chuyển /internal ra ngoài
import { z } from 'zod';
import { canManage, canWatch, FREE_MAX_HEIGHT, qualityHeight } from '@streamforge/shared/access';
import { optionalAuth, requireAuth } from '@streamforge/shared/auth';
import { HttpError } from '@streamforge/shared/errors';
import { createHttpApp } from '@streamforge/shared/http';
import { createMetrics } from '@streamforge/shared/metrics';
import { config } from './config.js';
import * as repo from './repository.js';
import { purgeVideoFiles } from './storage.js';

export const metrics = createMetrics('catalog');
export const eventsProcessed = new metrics.client.Counter({
  name: 'streamforge_catalog_events_total',
  help: 'Events consumed by the catalog, by type and outcome',
  labelNames: ['type', 'outcome'],
  registers: [metrics.registry],
});

const SORT_NAMES = Object.keys(repo.SORTS);
const VIDEO_STATUSES = ['UPLOADING', 'PROCESSING', 'READY', 'FAILED'];

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(VIDEO_STATUSES).optional(),
  tier: z.enum(['free', 'premium']).optional(),
  sort: z.enum(SORT_NAMES).default('newest'),
  period: z.enum(Object.keys(repo.PERIODS)).optional(),
  nextToken: z.string().max(1024).optional(),
});

// Khoá phân trang keyset: chỉ chấp nhận đúng các trường này. sort ghi lại kiểu sắp xếp đã tạo ra
// con trỏ; dùng con trỏ với kiểu khác thì bị từ chối.
const CursorSchema = z.strictObject({
  videoId: z.uuid(),
  createdAt: z.iso.datetime(),
  value: z
    .string()
    .regex(/^\d{1,18}(\.\d{1,4})?$/)
    .optional(),
  sort: z.enum(SORT_NAMES).optional(),
});

const IdSchema = z.object({ id: z.uuid('VideoId không hợp lệ') });
const RatingSchema = z.object({ stars: z.number().int().min(1).max(5) });

export function encodeCursor(lastKey) {
  return lastKey ? Buffer.from(JSON.stringify(lastKey)).toString('base64url') : null;
}

export function decodeCursor(token, sort) {
  if (!token) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success || (sort && (result.data.sort || 'newest') !== sort)) {
    throw new HttpError(400, 'nextToken không hợp lệ');
  }
  return result.data;
}

/** Dữ liệu trả cho client: bỏ trường nội bộ, thêm URL phát khi READY */
export function toPublicVideo(video) {
  const { rawBucket, rawS3Key, processedBucket, ...rest } = video;
  const ready = video.status === 'READY';
  // Luôn tính URL từ CDN_BASE_URL hiện tại, để đổi domain CDN không làm hỏng link của video cũ
  const base = `${config.cdnBaseUrl}/${video.videoId}`;
  return {
    ...rest,
    masterPlaylistUrl: ready ? `${base}/master.m3u8` : undefined,
    // q.path có từ khi tách sd/ và hd/; video cũ hơn để file phẳng trong thư mục video
    qualities: video.qualities?.map((q) => ({
      ...q,
      playlistUrl: `${base}/${q.path || `${q.resolution}.m3u8`}`,
      premiumOnly: qualityHeight(q.resolution) > FREE_MAX_HEIGHT,
    })),
    streamingUrl: ready ? `${base}/master.m3u8` : null,
    thumbnailUrl: ready ? `${base}/thumbnail.jpg` : null,
  };
}

async function sendPage(res, query, extra = {}) {
  const { limit, status, tier, sort, period, nextToken } = query;
  const { items, lastKey } = await repo.listVideos({
    limit,
    status,
    tier,
    sort,
    period,
    ...extra,
    startKey: decodeCursor(nextToken, sort),
  });
  res.json({
    success: true,
    count: items.length,
    nextToken: encodeCursor(lastKey && { ...lastKey, sort }),
    data: items.map(toPublicVideo),
  });
}

async function loadVideo(req) {
  const { id } = IdSchema.parse(req.params);
  const video = await repo.getVideoById(id);
  if (!video) throw new HttpError(404, `Video not found with ID: ${id}`);
  return video;
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function createApp({ purge = purgeVideoFiles } = {}) {
  return createHttpApp({
    service: 'catalog',
    metrics,
    routes(app) {
      app.get('/api/videos', wrap(async (req, res) => sendPage(res, ListQuerySchema.parse(req.query))));

      // Đặt trước '/:id' để "mine" không bị hiểu là videoId
      app.get(
        '/api/videos/mine',
        requireAuth,
        wrap(async (req, res) => sendPage(res, ListQuerySchema.parse(req.query), { ownerId: req.user.sub }))
      );

      app.get(
        '/api/videos/:id',
        optionalAuth,
        wrap(async (req, res) => {
          const video = await loadVideo(req);
          const myRating = req.user ? await repo.getUserRating(video.videoId, req.user.sub) : null;
          res.json({ success: true, data: { ...toPublicVideo(video), myRating } });
        })
      );

      app.put(
        '/api/videos/:id/rating',
        requireAuth,
        wrap(async (req, res) => {
          const video = await loadVideo(req);
          const { stars } = RatingSchema.parse(req.body);
          if (video.status !== 'READY') throw new HttpError(409, 'Chỉ chấm điểm được video đã sẵn sàng');
          if (!canWatch(req.user, video)) throw new HttpError(403, 'Video dành cho gói Premium');
          res.json({ success: true, data: await repo.rateVideo(video.videoId, req.user.sub, stars) });
        })
      );

      app.delete(
        '/api/videos/:id',
        requireAuth,
        wrap(async (req, res) => {
          const video = await loadVideo(req);
          if (!canManage(req.user, video)) throw new HttpError(403, 'Chỉ người upload mới thực hiện được thao tác này');
          if (video.status === 'PROCESSING') {
            throw new HttpError(409, 'Video đang được transcode, hãy xoá sau khi xử lý xong', { currentStatus: video.status });
          }
          // 1. DELETING có điều kiện; nếu bước sau lỗi, gọi DELETE lại sẽ chạy lại từ đây
          await repo.markDeleting(video.videoId);
          // 2. File gốc, HLS và cache CloudFront
          const result = await purge(video);
          // 3. Bản ghi và dấu đã xoá
          await repo.deleteVideoRecord(video.videoId);
          res.json({ success: true, message: `Video ${video.videoId} deleted successfully`, data: result });
        })
      );

      // Chỉ trong cụm (Service ClusterIP). Playback cần ownerId, tier, trạng thái, qualities để cấp vé xem.
      app.get(
        '/internal/videos/:id',
        wrap(async (req, res) => {
          const video = await loadVideo(req);
          res.json({
            success: true,
            data: {
              videoId: video.videoId,
              ownerId: video.ownerId,
              tier: video.tier,
              status: video.status,
              qualities: video.qualities || [],
            },
          });
        })
      );
    },
  });
}
