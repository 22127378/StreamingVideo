import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// Credentials giả để AWS SDK không dùng tới session thật trên máy. Các test dưới đây
// không gọi tới AWS: chúng dừng ở bước validate hoặc xác thực trước khi truy cập DynamoDB/S3.
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_ENDPOINT_URL ||= 'http://localhost:4566';

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config/aws.js');
const { encodeCursor, decodeCursor, toPublicVideo } = await import('../src/controllers/videoController.js');
const { generateUploadPresignedUrl } = await import('../src/services/s3Service.js');

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

const sign = (payload, opts = {}) =>
  jwt.sign(payload, config.jwtSecret, { algorithm: 'HS256', issuer: 'StreamForge-Auth', expiresIn: '1h', ...opts });

test('GET /health returns UP', async () => {
  const { status, body } = await call('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'UP');
});

test('unknown route returns 404', async () => {
  const { status } = await call('GET', '/api/nope');
  assert.equal(status, 404);
});

test('GET /api/videos rejects invalid query before touching DynamoDB', async () => {
  for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'status=DONE', 'nextToken=not-a-cursor']) {
    const { status } = await call('GET', `/api/videos?${qs}`);
    assert.equal(status, 400, qs);
  }
});

test('GET and DELETE /api/videos/:id reject non-UUID ids', async () => {
  assert.equal((await call('GET', '/api/videos/abc')).status, 400);
  assert.equal((await call('DELETE', '/api/videos/..%2F..')).status, 400);
});

test('cursor round-trips and rejects tampered keys', () => {
  const key = { videoId: VIDEO_A, entityType: 'VIDEO', createdAt: '2026-11-16T07:00:00.000Z' };
  assert.deepEqual(decodeCursor(encodeCursor(key)), key);
  assert.equal(encodeCursor(undefined), null);

  const tampered = Buffer.from(JSON.stringify({ ...key, extra: 'x' })).toString('base64url');
  assert.throws(() => decodeCursor(tampered), /nextToken/);
  const wrongType = Buffer.from(JSON.stringify({ ...key, entityType: 'USER' })).toString('base64url');
  assert.throws(() => decodeCursor(wrongType), /nextToken/);
});

test('toPublicVideo hides internal fields and adds URLs only when READY', () => {
  const ready = toPublicVideo({ videoId: VIDEO_A, entityType: 'VIDEO', status: 'READY' });
  assert.equal(ready.entityType, undefined);
  assert.equal(ready.streamingUrl, `${config.cdnBaseUrl}/${VIDEO_A}/master.m3u8`);

  const processing = toPublicVideo({ videoId: VIDEO_A, status: 'PROCESSING' });
  assert.equal(processing.streamingUrl, null);
  assert.equal(processing.thumbnailUrl, null);
});

test('verify-playback requires a valid Bearer token', async () => {
  assert.equal((await call('POST', '/api/auth/verify-playback', { body: { videoId: VIDEO_A } })).status, 401);

  const forged = jwt.sign({ sub: 'u', tier: 'premium', videoId: '*' }, 'wrong-secret', { issuer: 'StreamForge-Auth' });
  assert.equal((await call('POST', '/api/auth/verify-playback', { body: { videoId: VIDEO_A }, token: forged })).status, 401);

  const wrongIssuer = sign({ sub: 'u', tier: 'premium', videoId: '*' }, { issuer: 'someone-else' });
  assert.equal((await call('POST', '/api/auth/verify-playback', { body: { videoId: VIDEO_A }, token: wrongIssuer })).status, 401);

  const expired = sign({ sub: 'u', tier: 'premium', videoId: '*' }, { expiresIn: -10 });
  assert.equal((await call('POST', '/api/auth/verify-playback', { body: { videoId: VIDEO_A }, token: expired })).status, 401);
});

test('verify-playback validates body and rejects a token scoped to another video', async () => {
  const token = sign({ sub: 'u', tier: 'premium', videoId: VIDEO_B });
  assert.equal((await call('POST', '/api/auth/verify-playback', { body: {}, token })).status, 400);

  const { status, body } = await call('POST', '/api/auth/verify-playback', { body: { videoId: VIDEO_A }, token });
  assert.equal(status, 403);
  assert.match(body.message, /không dành cho video/);
});

test('playback-token rejects malformed input', async () => {
  assert.equal((await call('POST', '/api/auth/playback-token', { body: { tier: 'gold' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/playback-token', { body: { videoId: 'abc' } })).status, 400);
});

test('S3 presigned upload URL uses raw/{videoId}/source.{ext}', async () => {
  const result = await generateUploadPresignedUrl('sample.mov', 'video/quicktime', VIDEO_A);
  assert.equal(result.s3Key, `raw/${VIDEO_A}/source.mov`);
  assert.equal(result.bucket, config.rawBucket);
  assert.match(result.uploadUrl, /source\.mov/);
});
