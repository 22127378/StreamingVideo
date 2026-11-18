const env = process.env;

export const config = {
  // ivs: AWS IVS (cloud). local: MediaMTX trong docker compose (nhận RTMP, phát HLS, không cần AWS).
  provider: env.LIVE_PROVIDER || 'local',
  namePrefix: env.LIVE_NAME_PREFIX || 'streamforge-dev',
  // IVS: BASIC rẻ hơn (không transcode nhiều mức), LOW = độ trễ vài giây
  ivsChannelType: env.IVS_CHANNEL_TYPE || 'BASIC',
  ivsLatencyMode: env.IVS_LATENCY_MODE || 'LOW',
  // MediaMTX: địa chỉ cho trình duyệt/OBS (public) và API nội bộ để biết kênh nào đang phát
  localIngestUrl: env.LIVE_LOCAL_INGEST_URL || 'rtmp://localhost:1935/live',
  localPlaybackBaseUrl: env.LIVE_LOCAL_PLAYBACK_BASE_URL || 'http://localhost:8888/live',
  localApiUrl: env.LIVE_LOCAL_API_URL || 'http://localhost:9997',
  // Trạng thái đang phát lấy từ provider, giữ trong bộ nhớ vài giây để không gọi API mỗi request
  statusCacheSeconds: parseInt(env.LIVE_STATUS_CACHE_SECONDS || '10', 10),
  // Bình luận cũ hơn số ngày này bị xoá
  chatRetentionDays: parseInt(env.LIVE_CHAT_RETENTION_DAYS || '7', 10),
  // Mỗi người tối đa 1 bình luận trong khoảng này
  chatCooldownMs: parseInt(env.LIVE_CHAT_COOLDOWN_MS || '1000', 10),
};
