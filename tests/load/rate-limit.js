// k6: kiểm tra rate limit của endpoint ghi (mặc định 30 request / 10 phút / IP / pod).
// Gửi liên tục POST /api/auth/playback-token và đếm số request bị 429.
//
//   BASE_URL=https://dxxxx.cloudfront.net ./tests/load/run.sh rate-limit.js
//
// Chú ý: sau khi chạy, IP của bạn bị chặn các endpoint ghi (upload-url, complete, playback-token)
// cho tới hết cửa sổ 10 phút. Chạy cuối cùng, sau các kịch bản cần upload.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error('BASE_URL is required');
const REQUESTS = parseInt(__ENV.REQUESTS || '100', 10);
// Giới hạn mỗi pod; ALB chia request cho các pod nên tổng số request được phép ~ LIMIT * số pod
const LIMIT = parseInt(__ENV.LIMIT || '30', 10);
const PODS = parseInt(__ENV.PODS || '2', 10);

const allowed = new Counter('allowed_requests');
const limited = new Counter('rate_limited_requests');

export const options = {
  scenarios: {
    burst: { executor: 'shared-iterations', vus: 5, iterations: REQUESTS, maxDuration: '2m' },
  },
  thresholds: {
    // Phải có request bị chặn, và không được cho qua nhiều hơn LIMIT * PODS
    rate_limited_requests: ['count>0'],
    allowed_requests: [`count<=${LIMIT * PODS}`],
    // 429 là kết quả mong đợi, không tính là lỗi
    'http_req_failed{expected_response:true}': ['rate<0.01'],
  },
};

http.setResponseCallback(http.expectedStatuses(200, 429));

export default function () {
  const res = http.post(`${BASE_URL}/api/auth/playback-token`, JSON.stringify({ tier: 'free' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status === 429) {
    limited.add(1);
    check(res, { '429 has Retry-After': (r) => Number(r.headers['Retry-After']) > 0 });
  } else {
    allowed.add(1);
  }
}
