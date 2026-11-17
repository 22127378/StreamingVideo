// k6: tải lên đường đọc của API qua CloudFront (GET /api/videos, GET /api/videos/:id).
// Endpoint ghi bị rate limit theo IP nên không đưa vào đây, xem pipeline-burst.sh và rate-limit.js.
//
//   BASE_URL=https://dxxxx.cloudfront.net SCENARIO=load ./tests/load/run.sh api.js
//
// SCENARIO: smoke | load | stress | spike | soak (mặc định smoke)
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error('BASE_URL is required, for example https://dxxxx.cloudfront.net');
const SCENARIO = __ENV.SCENARIO || 'smoke';
// Ngưỡng p95 (ms). Phụ thuộc khoảng cách tới edge CloudFront, chỉnh theo nơi chạy test.
const LIST_P95 = __ENV.LIST_P95 || '800';
const DETAIL_P95 = __ENV.DETAIL_P95 || '500';

const profiles = {
  // Script chạy được, endpoint trả đúng
  smoke: { executor: 'constant-vus', vus: 1, duration: '30s' },
  // Tải bình thường dự kiến
  load: {
    executor: 'ramping-vus',
    stages: [
      { duration: '1m', target: 20 },
      { duration: '3m', target: 20 },
      { duration: '30s', target: 0 },
    ],
  },
  // Tăng dần để tìm điểm gãy (latency tăng vọt hoặc lỗi 5xx)
  stress: {
    executor: 'ramping-vus',
    stages: [
      { duration: '1m', target: 50 },
      { duration: '2m', target: 50 },
      { duration: '1m', target: 100 },
      { duration: '2m', target: 100 },
      { duration: '1m', target: 200 },
      { duration: '2m', target: 200 },
      { duration: '1m', target: 0 },
    ],
  },
  // Tăng đột ngột rồi giảm: hệ thống có phục hồi không
  spike: {
    executor: 'ramping-vus',
    stages: [
      { duration: '30s', target: 5 },
      { duration: '10s', target: 200 },
      { duration: '1m', target: 200 },
      { duration: '10s', target: 5 },
      { duration: '1m', target: 5 },
      { duration: '10s', target: 0 },
    ],
  },
  // Tải vừa trong thời gian dài: rò rỉ bộ nhớ, pod restart
  soak: { executor: 'constant-vus', vus: 10, duration: '30m' },
};

if (!profiles[SCENARIO]) throw new Error(`Unknown SCENARIO ${SCENARIO}`);

export const options = {
  scenarios: { [SCENARIO]: profiles[SCENARIO] },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:list}': [`p(95)<${LIST_P95}`],
    'http_req_duration{endpoint:detail}': [`p(95)<${DETAIL_P95}`],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const res = http.get(`${BASE_URL}/api/videos?limit=50`);
  if (res.status !== 200) throw new Error(`GET /api/videos returned ${res.status}`);
  const ids = (res.json('data') || []).map((v) => v.videoId);
  if (ids.length === 0) throw new Error('No videos found. Upload at least one video first (tests/e2e/smoke.sh)');
  return { ids };
}

export default function ({ ids }) {
  group('list', () => {
    const res = http.get(`${BASE_URL}/api/videos?limit=20`, { tags: { endpoint: 'list' } });
    check(res, {
      'list 200': (r) => r.status === 200,
      'list has data': (r) => Array.isArray(r.json('data')),
    });
  });

  group('detail', () => {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const res = http.get(`${BASE_URL}/api/videos/${id}`, { tags: { endpoint: 'detail' } });
    check(res, { 'detail 200': (r) => r.status === 200 });
  });

  sleep(1);
}
