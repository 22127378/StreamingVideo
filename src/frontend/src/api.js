// Gọi API StreamForge. Frontend và API cùng domain (CloudFront /api/*, hoặc proxy của Vite khi dev).

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, { body, token } = {}) {
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

export const listVideos = ({ limit = 12, nextToken } = {}) =>
  request('GET', `/videos?limit=${limit}${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`);

export const getVideo = (id) => request('GET', `/videos/${id}`);

export const deleteVideo = (id) => request('DELETE', `/videos/${id}`);

export const requestUpload = ({ file, title, tier }) =>
  request('POST', '/videos/upload-url', {
    body: {
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size,
      title: title || undefined,
      tier,
    },
  });

export const completeUpload = (videoId) => request('POST', '/videos/complete', { body: { videoId } });

export const issuePlaybackToken = ({ userId, tier, videoId }) =>
  request('POST', '/auth/playback-token', { body: { userId, tier, videoId } });

export const verifyPlayback = ({ token, videoId }) =>
  request('POST', '/auth/verify-playback', { body: { videoId }, token });

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
