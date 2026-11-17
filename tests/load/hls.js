// k6: mô phỏng người xem phát HLS qua CloudFront.
// Mỗi VU tải master.m3u8, chọn một rendition, tải playlist của rendition đó rồi tải lần lượt
// các segment với nhịp 4 giây (đúng độ dài segment), giống player thật.
//
//   BASE_URL=https://dxxxx.cloudfront.net VIEWERS=50 DURATION=5m ./tests/load/run.sh hls.js
//
// Chi phí: CloudFront tính theo dữ liệu tải ra (~$0.085/GB ở PriceClass_100).
// Rendition 720p ~2.5 Mbps, 50 người xem trong 5 phút ~ 4.7 GB ~ $0.40.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error('BASE_URL is required');
const VIEWERS = parseInt(__ENV.VIEWERS || '20', 10);
const DURATION = __ENV.DURATION || '3m';
const RENDITION = __ENV.RENDITION || ''; // trống = chọn ngẫu nhiên
const SEGMENT_P95 = __ENV.SEGMENT_P95 || '1500';
const PLAYLIST_P95 = __ENV.PLAYLIST_P95 || '500';

const segmentTime = new Trend('hls_segment_duration', true);
const playlistTime = new Trend('hls_playlist_duration', true);
const cacheHit = new Rate('cloudfront_cache_hit');

export const options = {
  scenarios: {
    viewers: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: VIEWERS },
        { duration: DURATION, target: VIEWERS },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Segment 4s phải tải xong nhanh hơn nhiều so với 4s, nếu không player sẽ bị giật
    hls_segment_duration: [`p(95)<${SEGMENT_P95}`],
    hls_playlist_duration: [`p(95)<${PLAYLIST_P95}`],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const res = http.get(`${BASE_URL}/api/videos?status=READY&limit=50`);
  const videos = (res.json('data') || []).filter((v) => v.streamingUrl);
  if (videos.length === 0) throw new Error('No READY videos to play');
  return { urls: videos.map((v) => v.streamingUrl) };
}

function recordCache(res) {
  const header = res.headers['X-Cache'] || '';
  cacheHit.add(header.startsWith('Hit'));
}

export default function ({ urls }) {
  const masterUrl = urls[Math.floor(Math.random() * urls.length)];
  const base = masterUrl.slice(0, masterUrl.lastIndexOf('/') + 1);

  const master = http.get(masterUrl, { tags: { kind: 'playlist' } });
  playlistTime.add(master.timings.duration);
  recordCache(master);
  if (!check(master, { 'master 200': (r) => r.status === 200 })) return;

  const variants = master.body.split('\n').filter((l) => l.endsWith('.m3u8'));
  const variant = (RENDITION && variants.find((v) => v.startsWith(RENDITION))) ||
    variants[Math.floor(Math.random() * variants.length)];

  const playlist = http.get(base + variant, { tags: { kind: 'playlist' } });
  playlistTime.add(playlist.timings.duration);
  recordCache(playlist);
  if (!check(playlist, { 'variant playlist 200': (r) => r.status === 200 })) return;

  const segments = playlist.body.split('\n').filter((l) => l.endsWith('.ts'));
  for (const segment of segments) {
    const res = http.get(base + segment, { tags: { kind: 'segment' } });
    segmentTime.add(res.timings.duration);
    recordCache(res);
    check(res, { 'segment 200': (r) => r.status === 200 });
    sleep(4);
  }
}
