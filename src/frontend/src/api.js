// Gọi các service StreamForge. Frontend và API cùng domain (CloudFront /api/*, hoặc proxy của Vite khi dev).
// ALB (local: gateway nginx) chia đường dẫn về từng service:
//   /api/auth/*      account     đăng nhập, gói
//   /api/uploads/*   upload      xin URL upload, xác nhận upload xong
//   /api/videos/*    catalog     danh sách, chi tiết, đánh giá, xoá
//   /api/playback/*  playback    cấp vé xem (signed cookies)
//   /api/live/*      live        kênh phát trực tiếp, đăng ký kênh, bình luận
import { getAccessToken } from './auth.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, { body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  return q.toString();
}

/** Danh sách công khai. tier: free | premium; sort: newest | oldest | views | rating; period: day | week | month | year */
export const listVideos = ({ limit = 12, nextToken, status, tier, sort, period } = {}) =>
  request('GET', `/videos?${qs({ limit, nextToken, status, tier, sort, period })}`);

/** Video của chính mình, mọi trạng thái */
export const listMyVideos = ({ limit = 24, nextToken } = {}) => request('GET', `/videos/mine?${qs({ limit, nextToken })}`);

export const rateVideo = (id, stars) => request('PUT', `/videos/${id}/rating`, { body: { stars } });

/** Chi tiết video; đã đăng nhập thì có thêm myRating (số sao mình đã chấm) */
export const getVideo = (id) => request('GET', `/videos/${id}`);

export const deleteVideo = (id) => request('DELETE', `/videos/${id}`);

export const requestUpload = ({ file, title, tier }) =>
  request('POST', '/uploads', {
    body: {
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size,
      title: title || undefined,
      tier,
    },
  });

export const completeUpload = (videoId) => request('POST', `/uploads/${videoId}/complete`);

/**
 * Xin quyền xem: playback-service kiểm tra gói rồi đặt CloudFront signed cookies cho /videos/{id}/.
 * Sau đó trình phát tải HLS bình thường, trình duyệt tự gửi cookie (cùng domain).
 */
export const startPlayback = (id) => request('POST', `/playback/${id}`);

// ---------------- Live
/** Danh sách kênh, đang phát trước; đã đăng nhập thì mỗi kênh có subscribed */
export const listChannels = () => request('GET', '/live/channels');

export const getChannel = (id) => request('GET', `/live/channels/${id}`);

export const setSubscription = (id, subscribed) =>
  request(subscribed ? 'PUT' : 'DELETE', `/live/channels/${id}/subscription`);

/** Không có after: các bình luận mới nhất. Có after: bình luận có id lớn hơn after */
export const listMessages = (id, after) => request('GET', `/live/channels/${id}/messages?${qs({ after })}`);

export const sendMessage = (id, body) => request('POST', `/live/channels/${id}/messages`, { body: { body } });

export const deleteMessage = (id, messageId) => request('DELETE', `/live/channels/${id}/messages/${messageId}`);

/** Kênh của mình, kèm địa chỉ ingest và khoá stream cho OBS (404 khi chưa có kênh) */
export const getStudio = () => request('GET', '/live/studio');

export const createChannel = (title) => request('POST', '/live/studio', { body: { title } });

export const updateStudio = (title) => request('PUT', '/live/studio', { body: { title } });

export const resetStreamKey = () => request('POST', '/live/studio/stream-key');

export const getMe = () => request('GET', '/auth/me');

export const upgradeToPremium = () => request('POST', '/auth/upgrade');

export const devLogin = ({ email, tier }) => request('POST', '/auth/dev-login', { body: { email, tier } });

/**
 * PUT file lên presigned URL của S3, báo tiến trình qua onProgress(0..1).
 * Dùng XMLHttpRequest vì fetch chưa báo được tiến trình upload.
 * Trình duyệt tự gửi Content-Length bằng đúng kích thước file, khớp với giá trị đã ký.
 */
export function uploadToS3(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`S3 từ chối upload (HTTP ${xhr.status})`));
    xhr.onerror = () => reject(new Error('Không kết nối được tới S3 (mạng hoặc CORS)'));
    xhr.send(file);
  });
}
