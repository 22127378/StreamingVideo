import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

// Credentials giả để AWS SDK không dùng tới session thật trên máy. Các test dưới đây
// không gọi tới AWS: chúng dừng ở bước validate hoặc xác thực trước khi truy cập database/S3.
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_ENDPOINT_URL ||= 'http://localhost:4566';

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config/aws.js');
const { encodeCursor, decodeCursor, toPublicVideo } = await import('../src/controllers/videoController.js');
const { generateUploadPresignedUrl } = await import('../src/services/s3Service.js');
const { videoInvalidationPaths, invalidateVideoCache } = await import('../src/services/cloudfrontService.js');
const { signedPlaybackCookies, canWatch } = await import('../src/services/playbackService.js');

const VIDEO_A = '11111111-1111-4111-8111-111111111111';
const VIDEO_B = '22222222-2222-4222-8222-222222222222';

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function devLogin(email, tier = 'free') {
  const { body } = await call('POST', '/api/auth/dev-login', { body: { email, tier } });
  return body.data.token;
}

test('GET /health returns UP', async () => {
  const { status, body } = await call('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'UP');
});

test('unknown route returns 404', async () => {
  const { status } = await call('GET', '/api/nope');
  assert.equal(status, 404);
});

test('GET /api/videos rejects invalid query before touching the database', async () => {
  for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'status=DONE', 'nextToken=not-a-cursor']) {
    const { status } = await call('GET', `/api/videos?${qs}`);
    assert.equal(status, 400, qs);
  }
});

test('GET and DELETE /api/videos/:id reject non-UUID ids', async () => {
  assert.equal((await call('GET', '/api/videos/abc')).status, 400);
  const token = await devLogin('erin@example.com');
  assert.equal((await call('DELETE', '/api/videos/..%2F..', { token })).status, 400);
});

test('cursor round-trips and rejects tampered keys', () => {
  const key = { videoId: VIDEO_A, createdAt: '2026-11-16T07:00:00.000Z' };
  assert.deepEqual(decodeCursor(encodeCursor(key)), key);
  assert.equal(encodeCursor(undefined), null);

  const tampered = Buffer.from(JSON.stringify({ ...key, extra: 'x' })).toString('base64url');
  assert.throws(() => decodeCursor(tampered), /nextToken/);
  const notUuid = Buffer.from(JSON.stringify({ ...key, videoId: "x' OR 1=1" })).toString('base64url');
  assert.throws(() => decodeCursor(notUuid), /nextToken/);
});

test('toPublicVideo hides internal fields and adds URLs only when READY', () => {
  const ready = toPublicVideo({ videoId: VIDEO_A, status: 'READY' });
  assert.equal(ready.streamingUrl, `${config.cdnBaseUrl}/${VIDEO_A}/master.m3u8`);

  // URL lưu từ cấu hình CDN cũ bị thay bằng URL tính từ CDN_BASE_URL hiện tại
  const stale = toPublicVideo({
    videoId: VIDEO_A,
    status: 'READY',
    thumbnailUrl: 'https://old.example/x/thumbnail.jpg',
    qualities: [{ resolution: '720p', playlistUrl: 'https://old.example/x/720p.m3u8' }],
  });
  assert.equal(stale.thumbnailUrl, `${config.cdnBaseUrl}/${VIDEO_A}/thumbnail.jpg`);
  assert.equal(stale.qualities[0].playlistUrl, `${config.cdnBaseUrl}/${VIDEO_A}/720p.m3u8`);

  const processing = toPublicVideo({ videoId: VIDEO_A, status: 'PROCESSING' });
  assert.equal(processing.streamingUrl, null);
  assert.equal(processing.thumbnailUrl, null);
});

test('auth config reports dev mode when Cognito is not configured', async () => {
  const { status, body } = await call('GET', '/api/auth/config');
  assert.equal(status, 200);
  assert.deepEqual(body.data, { mode: 'dev' });
});

test('dev-login issues a token and /me returns the user and tier', async () => {
  assert.equal((await call('POST', '/api/auth/dev-login', { body: { email: 'not-an-email' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/dev-login', { body: { email: 'a@b.co', tier: 'gold' } })).status, 400);

  const token = await devLogin('alice@example.com');
  const me = await call('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.email, 'alice@example.com');
  assert.equal(me.body.data.tier, 'free');
  // Cùng email thì cùng sub (để vẫn là chủ video cũ)
  const again = await call('GET', '/api/auth/me', { token: await devLogin('ALICE@example.com') });
  assert.equal(again.body.data.sub, me.body.data.sub);
});

test('protected routes reject missing, forged, foreign and expired tokens', async () => {
  const sign = (payload, opts = {}) =>
    jwt.sign(payload, config.auth.jwtSecret, { algorithm: 'HS256', issuer: 'StreamForge-Dev', expiresIn: '1h', ...opts });
  const user = { sub: 'u', email: 'u@example.com', tier: 'premium' };
  const tokens = {
    missing: undefined,
    forged: jwt.sign(user, 'wrong-secret', { issuer: 'StreamForge-Dev' }),
    wrongIssuer: sign(user, { issuer: 'someone-else' }),
    expired: sign(user, { expiresIn: -10 }),
  };
  for (const [name, token] of Object.entries(tokens)) {
    assert.equal((await call('GET', '/api/auth/me', { token })).status, 401, `me ${name}`);
    assert.equal((await call('POST', `/api/videos/${VIDEO_A}/playback`, { token })).status, 401, `playback ${name}`);
    assert.equal((await call('POST', '/api/videos/upload-url', { token, body: {} })).status, 401, `upload ${name}`);
    assert.equal((await call('DELETE', `/api/videos/${VIDEO_A}`, { token })).status, 401, `delete ${name}`);
  }
});

test('upgrade turns a free dev user into premium', async () => {
  const token = await devLogin('bob@example.com');
  const { status, body } = await call('POST', '/api/auth/upgrade', { token });
  assert.equal(status, 200);
  assert.equal(body.data.tier, 'premium');
  const me = await call('GET', '/api/auth/me', { token: body.data.token });
  assert.equal(me.body.data.tier, 'premium');
});

test('premium videos are only watchable on the premium tier', () => {
  assert.ok(canWatch({ tier: 'free' }, { tier: 'free' }));
  assert.ok(!canWatch({ tier: 'free' }, { tier: 'premium' }));
  assert.ok(canWatch({ tier: 'premium' }, { tier: 'premium' }));
  assert.ok(canWatch({ tier: 'premium' }, { tier: 'free' }));
});

test('signed playback cookies are scoped to one video and expire', () => {
  assert.equal(signedPlaybackCookies(VIDEO_A), null, 'no key configured locally');

  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saved = { id: config.cloudfrontKeyPairId, key: config.cloudfrontPrivateKey, cdn: config.cdnBaseUrl };
  Object.assign(config, {
    cloudfrontKeyPairId: 'K2TESTKEYID',
    cloudfrontPrivateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    cdnBaseUrl: 'https://d1.cloudfront.net/videos',
  });
  try {
    const now = Date.UTC(2026, 10, 17);
    const signed = signedPlaybackCookies(VIDEO_A, now);
    assert.equal(signed.path, `/videos/${VIDEO_A}/`);
    assert.deepEqual(Object.keys(signed.cookies).sort(), [
      'CloudFront-Key-Pair-Id',
      'CloudFront-Policy',
      'CloudFront-Signature',
    ]);
    assert.equal(signed.cookies['CloudFront-Key-Pair-Id'], 'K2TESTKEYID');
    const policy = JSON.parse(
      Buffer.from(signed.cookies['CloudFront-Policy'].replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64').toString()
    );
    const statement = policy.Statement[0];
    assert.equal(statement.Resource, `https://d1.cloudfront.net/videos/${VIDEO_A}/*`);
    assert.equal(statement.Condition.DateLessThan['AWS:EpochTime'], now / 1000 + config.playbackCookieTtlSeconds);
  } finally {
    Object.assign(config, { cloudfrontKeyPairId: saved.id, cloudfrontPrivateKey: saved.key, cdnBaseUrl: saved.cdn });
  }
});

test('playback validates the video id', async () => {
  const token = await devLogin('carol@example.com');
  assert.equal((await call('POST', '/api/videos/abc/playback', { token })).status, 400);
});

test('S3 presigned upload URL uses raw/{videoId}/source.{ext} and signs size and type', async () => {
  const result = await generateUploadPresignedUrl('sample.mov', 'video/quicktime', VIDEO_A, 1234);
  assert.equal(result.s3Key, `raw/${VIDEO_A}/source.mov`);
  assert.equal(result.bucket, config.rawBucket);
  assert.match(result.uploadUrl, /source\.mov/);
  const signed = new URL(result.uploadUrl).searchParams.get('X-Amz-SignedHeaders').split(';');
  assert.ok(signed.includes('content-length') && signed.includes('content-type'), signed.join(';'));
  assert.deepEqual(result.requiredHeaders, { 'Content-Type': 'video/quicktime', 'Content-Length': '1234' });

  const sneaky = await generateUploadPresignedUrl('clip.mp4/../../etc', 'video/mp4', VIDEO_A, 10);
  assert.equal(sneaky.s3Key, `raw/${VIDEO_A}/source.mp4`);
});

test('CloudFront invalidation covers the viewer path and the rewritten cache key', async () => {
  assert.deepEqual(videoInvalidationPaths(VIDEO_A, 'https://d1.cloudfront.net/videos'), [
    `/videos/${VIDEO_A}/*`,
    `/${VIDEO_A}/*`,
  ]);
  assert.deepEqual(videoInvalidationPaths(VIDEO_A, 'https://d1.cloudfront.net/videos/'), [
    `/videos/${VIDEO_A}/*`,
    `/${VIDEO_A}/*`,
  ]);
  // Không có tiền tố thì chỉ một đường dẫn
  assert.deepEqual(videoInvalidationPaths(VIDEO_A, 'https://d1.cloudfront.net'), [`/${VIDEO_A}/*`]);
  // Không có distribution (local) thì bỏ qua, không gọi AWS
  assert.deepEqual(await invalidateVideoCache(VIDEO_A), {
    invalidated: false,
    reason: 'CLOUDFRONT_DISTRIBUTION_ID not set',
  });
});

test('upload-url requires a fileSize within MAX_UPLOAD_BYTES', async () => {
  const token = await devLogin('dave@example.com');
  const body = { fileName: 'a.mp4', contentType: 'video/mp4' };
  assert.equal((await call('POST', '/api/videos/upload-url', { body, token })).status, 400);
  assert.equal((await call('POST', '/api/videos/upload-url', { body: { ...body, fileSize: 0 }, token })).status, 400);
  const tooBig = await call('POST', '/api/videos/upload-url', {
    body: { ...body, fileSize: config.maxUploadBytes + 1 },
    token,
  });
  assert.equal(tooBig.status, 400);
  assert.match(JSON.stringify(tooBig.body.errors), /fileSize/);
});

test('write endpoints are rate limited per client IP', async () => {
  const limited = createApp({ rateLimit: { max: 2, windowSeconds: 60 } }).listen(0);
  const url = `http://127.0.0.1:${limited.address().port}/api/auth/dev-login`;
  const post = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"x"}' });
  try {
    assert.equal((await post()).status, 400);
    assert.equal((await post()).status, 400);
    const third = await post();
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    // Health và các route đọc không bị giới hạn
    assert.equal((await fetch(`http://127.0.0.1:${limited.address().port}/health`)).status, 200);
  } finally {
    limited.close();
  }
});
