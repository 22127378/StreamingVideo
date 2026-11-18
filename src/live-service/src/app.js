// Live service: phát trực tiếp, đăng ký kênh, bình luận trực tiếp.
//   GET    /api/live/channels                       danh sách kênh (đang phát trước), có subscribed nếu đăng nhập
//   GET    /api/live/channels/:id                   chi tiết kênh + URL phát HLS
//   PUT    /api/live/channels/:id/subscription      đăng ký kênh
//   DELETE /api/live/channels/:id/subscription      huỷ đăng ký
//   GET    /api/live/channels/:id/messages?after=   bình luận (trình duyệt hỏi định kỳ bằng after)
//   POST   /api/live/channels/:id/messages          gửi bình luận (đăng nhập)
//   DELETE /api/live/channels/:id/messages/:msgId   chủ kênh hoặc admin xoá bình luận
//   GET    /api/live/studio                         kênh của mình: địa chỉ ingest + khoá stream cho OBS
//   POST   /api/live/studio                         tạo kênh (mỗi người một kênh)
//   PUT    /api/live/studio                         đổi tiêu đề buổi phát
//   POST   /api/live/studio/stream-key              đổi khoá stream (khi bị lộ)
//   POST   /internal/live/auth                      MediaMTX hỏi khoá khi OBS đẩy luồng (chỉ provider local)
//
// Bình luận đi qua PostgreSQL và trình duyệt hỏi lại mỗi vài giây (after = id cuối đã nhận). Không cần
// WebSocket hay Redis: pod nào cũng trả lời được, ALB/CloudFront không cần cấu hình thêm.
import crypto from 'node:crypto';
import { z } from 'zod';
import { optionalAuth, requireAuth } from '@streamforge/shared/auth';
import { HttpError } from '@streamforge/shared/errors';
import { createHttpApp, createRateLimiter } from '@streamforge/shared/http';
import { createMetrics } from '@streamforge/shared/metrics';
import { config } from './config.js';
import { createNameResolver } from './names.js';
import { cachedLiveStatus, createProvider } from './providers.js';
import * as defaultRepo from './repository.js';

export const metrics = createMetrics('live');
const chatMessages = new metrics.client.Counter({
  name: 'streamforge_live_chat_messages_total',
  help: 'Chat messages accepted by the live service',
  registers: [metrics.registry],
});
const subscriptionChanges = new metrics.client.Counter({
  name: 'streamforge_live_subscription_changes_total',
  help: 'Channel subscribe and unsubscribe requests that changed state',
  labelNames: ['action'],
  registers: [metrics.registry],
});
const liveChannelsGauge = new metrics.client.Gauge({
  name: 'streamforge_live_channels_live',
  help: 'Channels currently streaming, as last reported by the provider',
  registers: [metrics.registry],
});

const IdSchema = z.object({ id: z.uuid('ChannelId không hợp lệ') });
const MessageIdSchema = z.object({ id: z.uuid(), messageId: z.coerce.number().int().positive() });
const TitleSchema = z.object({ title: z.string().trim().max(120).default('') });
const MessageSchema = z.object({ body: z.string().trim().min(1, 'Bình luận trống').max(300) });
const MessagesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
// Payload MediaMTX gửi tới authHTTPAddress
const MediaAuthSchema = z.object({
  action: z.string(),
  path: z.string().default(''),
  query: z.string().default(''),
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** So sánh khoá không lộ thời gian */
function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Dữ liệu kênh công khai: bỏ khoá, địa chỉ ingest và định danh nội bộ của provider */
export function toPublicChannel(channel, status) {
  const live = status?.get(channel.providerChannelId);
  return {
    channelId: channel.channelId,
    ownerId: channel.ownerId,
    ownerName: channel.ownerName,
    title: channel.title,
    subscriberCount: channel.subscriberCount,
    subscribed: Boolean(channel.subscribed),
    isLive: Boolean(live),
    viewerCount: live?.viewerCount ?? 0,
    startedAt: live?.startedAt ?? null,
    // Kênh IVS công khai: ai cũng tải được HLS, chỉ chủ kênh đẩy luồng được (cần khoá)
    playbackUrl: channel.playbackUrl,
  };
}

/**
 * @param {{ repo?: typeof defaultRepo, provider?: object, liveStatus?: () => Promise<Map>,
 *   displayName?: (user) => Promise<string>, now?: () => number }} deps
 */
export function createApp({
  repo = defaultRepo,
  provider = createProvider(),
  liveStatus = cachedLiveStatus(provider),
  displayName = createNameResolver(),
  now = Date.now,
} = {}) {
  const lastMessageAt = new Map(); // userId -> thời điểm gửi bình luận gần nhất
  const chatLimit = createRateLimiter({ max: 60, windowSeconds: 60 });
  const studioLimit = createRateLimiter({ max: 20, windowSeconds: 60 });

  async function status() {
    const s = await liveStatus();
    liveChannelsGauge.set(s.size);
    return s;
  }

  async function loadChannel(req) {
    const { id } = IdSchema.parse(req.params);
    const channel = await repo.getChannel(id, req.user?.sub ?? null);
    if (!channel) throw new HttpError(404, 'Không tìm thấy kênh');
    return channel;
  }

  async function myChannel(req) {
    const channel = await repo.getChannelByOwner(req.user.sub);
    if (!channel) throw new HttpError(404, 'Bạn chưa tạo kênh');
    return channel;
  }

  async function studioView(channel) {
    const s = await status();
    return {
      ...toPublicChannel(channel, s),
      ingestEndpoint: channel.ingestEndpoint,
      streamKey: await provider.getStreamKey(channel),
    };
  }

  return createHttpApp({
    service: 'live',
    metrics,
    routes(app) {
      app.get(
        '/api/live/channels',
        optionalAuth,
        wrap(async (req, res) => {
          const [channels, s] = await Promise.all([repo.listChannels({ viewerId: req.user?.sub ?? null }), status()]);
          const data = channels
            .map((c) => toPublicChannel(c, s))
            // Đang phát trước (nhiều người xem hơn trước), sau đó giữ thứ tự theo số người đăng ký
            .sort((a, b) => Number(b.isLive) - Number(a.isLive) || b.viewerCount - a.viewerCount);
          res.json({ success: true, count: data.length, data });
        })
      );

      app.get(
        '/api/live/channels/:id',
        optionalAuth,
        wrap(async (req, res) => {
          const channel = await loadChannel(req);
          res.json({ success: true, data: { ...toPublicChannel(channel, await status()), isOwner: channel.ownerId === req.user?.sub } });
        })
      );

      for (const [method, subscribe] of [
        ['put', true],
        ['delete', false],
      ]) {
        app[method](
          '/api/live/channels/:id/subscription',
          requireAuth,
          wrap(async (req, res) => {
            const channel = await loadChannel(req);
            if (subscribe && channel.ownerId === req.user.sub) throw new HttpError(400, 'Không thể tự đăng ký kênh của mình');
            const before = channel.subscribed;
            const subscriberCount = await repo.setSubscription(channel.channelId, req.user.sub, subscribe);
            if (before !== subscribe) subscriptionChanges.inc({ action: subscribe ? 'subscribe' : 'unsubscribe' });
            res.json({ success: true, data: { subscribed: subscribe, subscriberCount } });
          })
        );
      }

      app.get(
        '/api/live/channels/:id/messages',
        wrap(async (req, res) => {
          const { id } = IdSchema.parse(req.params);
          const { after, limit } = MessagesQuerySchema.parse(req.query);
          const data = await repo.listMessages(id, { after, limit });
          res.json({ success: true, count: data.length, data });
        })
      );

      app.post(
        '/api/live/channels/:id/messages',
        chatLimit,
        requireAuth,
        wrap(async (req, res) => {
          const { body } = MessageSchema.parse(req.body);
          const channel = await loadChannel(req);
          const t = now();
          if (t - (lastMessageAt.get(req.user.sub) ?? -Infinity) < config.chatCooldownMs) {
            throw new HttpError(429, 'Bạn gửi bình luận quá nhanh');
          }
          lastMessageAt.set(req.user.sub, t);
          if (lastMessageAt.size > 50_000) lastMessageAt.clear();

          const message = await repo.addMessage({
            channelId: channel.channelId,
            userId: req.user.sub,
            userName: await displayName(req.user),
            body,
          });
          chatMessages.inc();
          res.status(201).json({ success: true, data: message });
        })
      );

      app.delete(
        '/api/live/channels/:id/messages/:messageId',
        requireAuth,
        wrap(async (req, res) => {
          const { id, messageId } = MessageIdSchema.parse(req.params);
          const channel = await repo.getChannel(id);
          if (!channel) throw new HttpError(404, 'Không tìm thấy kênh');
          if (channel.ownerId !== req.user.sub && !req.user.admin) {
            throw new HttpError(403, 'Chỉ chủ kênh mới xoá được bình luận');
          }
          if (!(await repo.deleteMessage(id, messageId))) throw new HttpError(404, 'Không tìm thấy bình luận');
          res.json({ success: true });
        })
      );

      app.get(
        '/api/live/studio',
        requireAuth,
        wrap(async (req, res) => res.json({ success: true, data: await studioView(await myChannel(req)) }))
      );

      app.post(
        '/api/live/studio',
        studioLimit,
        requireAuth,
        wrap(async (req, res) => {
          const { title } = TitleSchema.parse(req.body || {});
          const existing = await repo.getChannelByOwner(req.user.sub);
          if (existing) return res.json({ success: true, data: await studioView(existing) });

          const channelId = crypto.randomUUID();
          const created = await provider.createChannel(channelId);
          const channel = await repo.insertChannel({
            channelId,
            ownerId: req.user.sub,
            ownerName: await displayName(req.user),
            title,
            provider: provider.name,
            ...created,
          });
          if (!channel) {
            // Request khác của cùng người vừa tạo xong: bỏ kênh thừa ở provider, trả kênh đã có
            await provider.deleteChannel({ channelId, ...created }).catch(() => {});
            return res.json({ success: true, data: await studioView(await myChannel(req)) });
          }
          res.status(201).json({ success: true, data: await studioView(channel) });
        })
      );

      app.put(
        '/api/live/studio',
        requireAuth,
        wrap(async (req, res) => {
          const { title } = TitleSchema.parse(req.body || {});
          const channel = await myChannel(req);
          const updated = await repo.updateChannel(channel.channelId, { title, ownerName: await displayName(req.user) });
          res.json({ success: true, data: await studioView(updated) });
        })
      );

      app.post(
        '/api/live/studio/stream-key',
        studioLimit,
        requireAuth,
        wrap(async (req, res) => {
          const channel = await myChannel(req);
          const streamKeyRef = await provider.resetStreamKey(channel);
          const updated = await repo.updateChannel(channel.channelId, { streamKeyRef });
          res.json({ success: true, data: await studioView(updated) });
        })
      );

      // MediaMTX (chỉ khi chạy local) gọi trước khi cho đọc hoặc đẩy luồng. 200 = cho phép.
      // Ingress và gateway không chuyển /internal/* ra ngoài.
      app.post(
        '/internal/live/auth',
        wrap(async (req, res) => {
          if (provider.name !== 'local') return res.status(404).end();
          const { action, path, query } = MediaAuthSchema.parse(req.body || {});
          if (action === 'read' || action === 'playback') return res.status(200).end();
          if (action !== 'publish') return res.status(401).end();

          const match = path.match(/^live\/([0-9a-f-]{36})$/i);
          const key = new URLSearchParams(query).get('key') || '';
          const channel = match ? await repo.getChannel(match[1]) : null;
          if (channel && key && sameSecret(key, channel.streamKeyRef)) return res.status(200).end();
          console.warn(`[live] rejected publish on ${path}`);
          return res.status(401).end();
        })
      );
    },
  });
}
