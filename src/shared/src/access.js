// Luật xem video theo gói. Dùng chung cho playback (cấp vé xem) và catalog (cho chấm điểm).

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

/** Chủ video hoặc admin (xoá, xem video chưa sẵn sàng của mình) */
export function canManage(user, video) {
  return Boolean(user.admin) || (Boolean(video.ownerId) && video.ownerId === user.sub);
}

/** Chiều cao (cạnh ngắn) của một mức chất lượng, ví dụ '1080p' -> 1080 */
export const qualityHeight = (resolution) => parseInt(resolution, 10) || 0;
