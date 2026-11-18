// Nơi nhận và phát luồng video. Service chỉ quản lý kênh (tạo, khoá stream, trạng thái), không
// đi qua dữ liệu video: streamer đẩy RTMP(S) thẳng vào provider, người xem tải HLS thẳng từ provider.
//
// - ivs: Amazon IVS. Mỗi kênh StreamForge là một kênh IVS; khoá stream nằm ở IVS, database chỉ giữ ARN.
//   Người xem phát HLS từ CDN của IVS (*.live-video.net).
// - local: MediaMTX (docker compose). Đường dẫn live/<channelId>; khi OBS đẩy luồng, MediaMTX hỏi
//   POST /internal/live/auth xem khoá có đúng không (xem app.js).
import crypto from 'node:crypto';
import {
  CreateChannelCommand,
  CreateStreamKeyCommand,
  DeleteChannelCommand,
  DeleteStreamKeyCommand,
  GetStreamKeyCommand,
  IvsClient,
  ListStreamsCommand,
} from '@aws-sdk/client-ivs';
import { awsClientConfig } from '@streamforge/shared/aws';
import { config } from './config.js';

/**
 * @typedef {{ providerChannelId: string, ingestEndpoint: string, playbackUrl: string, streamKeyRef: string }} ProviderChannel
 * @typedef {Map<string, { viewerCount: number, startedAt?: string }>} LiveSet providerChannelId -> trạng thái
 */

export function createIvsProvider({ client = new IvsClient(awsClientConfig) } = {}) {
  return {
    name: 'ivs',

    /** @returns {Promise<ProviderChannel>} */
    async createChannel(channelId) {
      const out = await client.send(
        new CreateChannelCommand({
          name: `${config.namePrefix}-${channelId}`,
          type: config.ivsChannelType,
          latencyMode: config.ivsLatencyMode,
          tags: { Project: 'streamforge', ChannelId: channelId },
        })
      );
      return {
        providerChannelId: out.channel.arn,
        // OBS: rtmps://<ingestEndpoint>:443/app/
        ingestEndpoint: `rtmps://${out.channel.ingestEndpoint}:443/app/`,
        playbackUrl: out.channel.playbackUrl,
        streamKeyRef: out.streamKey.arn,
      };
    },

    async getStreamKey(channel) {
      const out = await client.send(new GetStreamKeyCommand({ arn: channel.streamKeyRef }));
      return out.streamKey.value;
    },

    /** Đổi khoá (khoá cũ bị lộ): IVS chỉ cho 1 khoá mỗi kênh nên xoá rồi tạo lại */
    async resetStreamKey(channel) {
      await client.send(new DeleteStreamKeyCommand({ arn: channel.streamKeyRef }));
      const out = await client.send(new CreateStreamKeyCommand({ channelArn: channel.providerChannelId }));
      return out.streamKey.arn;
    },

    /** @returns {Promise<LiveSet>} */
    async liveChannels() {
      const live = new Map();
      let nextToken;
      do {
        const out = await client.send(new ListStreamsCommand({ maxResults: 100, nextToken }));
        for (const s of out.streams || []) {
          if (s.state === 'LIVE') {
            live.set(s.channelArn, { viewerCount: s.viewerCount ?? 0, startedAt: s.startTime?.toISOString() });
          }
        }
        nextToken = out.nextToken;
      } while (nextToken);
      return live;
    },

    async deleteChannel(channel) {
      await client.send(new DeleteChannelCommand({ arn: channel.providerChannelId }));
    },
  };
}

export function createLocalProvider({ fetchImpl = fetch } = {}) {
  return {
    name: 'local',

    async createChannel(channelId) {
      return {
        providerChannelId: `live/${channelId}`,
        ingestEndpoint: config.localIngestUrl,
        playbackUrl: `${config.localPlaybackBaseUrl}/${channelId}/index.m3u8`,
        // Không có dịch vụ giữ khoá: lưu chính khoá (chỉ dùng khi chạy local)
        streamKeyRef: crypto.randomBytes(16).toString('hex'),
      };
    },

    // OBS: server = ingestEndpoint, stream key = "<channelId>?key=<khoá>" (MediaMTX dùng phần trước "?"
    // làm đường dẫn và chuyển phần query cho bước kiểm tra khoá)
    async getStreamKey(channel) {
      return `${channel.channelId}?key=${channel.streamKeyRef}`;
    },

    async resetStreamKey() {
      return crypto.randomBytes(16).toString('hex');
    },

    async liveChannels() {
      const res = await fetchImpl(`${config.localApiUrl}/v3/paths/list?itemsPerPage=1000`);
      if (!res.ok) throw new Error(`MediaMTX API ${res.status}`);
      const body = await res.json();
      const live = new Map();
      for (const p of body.items || []) {
        if (p.ready) live.set(p.name, { viewerCount: (p.readers || []).length, startedAt: p.readyTime || undefined });
      }
      return live;
    },

    async deleteChannel() {},
  };
}

export function createProvider(name = config.provider) {
  if (name === 'ivs') return createIvsProvider();
  if (name === 'local') return createLocalProvider();
  throw new Error(`LIVE_PROVIDER không hợp lệ: ${name} (ivs | local)`);
}

/**
 * Bọc liveChannels() bằng cache ngắn. Provider lỗi thì giữ kết quả cũ (hoặc coi như không kênh nào
 * đang phát) để danh sách kênh và bình luận vẫn dùng được.
 */
export function cachedLiveStatus(provider, { ttlMs = config.statusCacheSeconds * 1000, now = Date.now } = {}) {
  let value = new Map();
  let fetchedAt = -Infinity;
  let pending = null;
  return async function liveStatus() {
    if (now() - fetchedAt < ttlMs) return value;
    pending ??= provider
      .liveChannels()
      .then((v) => {
        value = v;
      })
      .catch((err) => console.warn(`[live] provider status failed: ${err.message}`))
      .finally(() => {
        fetchedAt = now();
        pending = null;
      });
    await pending;
    return value;
  };
}
