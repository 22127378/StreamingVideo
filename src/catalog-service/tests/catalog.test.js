// Test không cần database chạy mặc định. Phần dùng PostgreSQL thật chạy khi DB_TEST=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

process.env.AWS_ACCESS_KEY_ID ||= 'test';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test';
process.env.AWS_ENDPOINT_URL ||= 'http://localhost:4566';

const { issueDevToken } = await import('@streamforge/shared/auth');
const { createApp, encodeCursor, decodeCursor, toPublicVideo } = await import('../src/app.js');
const { videoInvalidationPaths } = await import('../src/storage.js');

const purged = [];
const server = createApp({ purge: async (v) => purged.push(v.videoId) || { deletedObjects: 0 } }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const VIDEO_A = '11111111-1111-4111-8111-111111111111';

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

test('list rejects invalid query before touching the database', async () => {
  for (const qs of ['limit=0', 'limit=101', 'status=DONE', 'nextToken=bad', 'sort=random', 'tier=gold', 'period=decade']) {
    assert.equal((await call('GET', `/api/videos?${qs}`)).status, 400, qs);
  }
});

test('cursor round trip, tampering and sort mismatch', () => {
  const key = { videoId: VIDEO_A, createdAt: '2026-11-17T00:00:00.000Z', value: '42', sort: 'views' };
  assert.deepEqual(decodeCursor(encodeCursor(key), 'views'), key);
  assert.throws(() => decodeCursor(encodeCursor(key), 'rating'), /nextToken/);
  assert.throws(() => decodeCursor(encodeCursor({ ...key, extra: 1 }), 'views'), /nextToken/);
  assert.equal(encodeCursor(undefined), null);
});

test('public video hides storage fields and marks premium-only qualities', () => {
  const v = toPublicVideo({
    videoId: VIDEO_A,
    status: 'READY',
    rawBucket: 'raw',
    rawS3Key: 'raw/x',
    processedBucket: 'p',
    qualities: [
      { resolution: '1080p', path: 'hd/1080p.m3u8' },
      { resolution: '720p', path: 'sd/720p.m3u8' },
    ],
  });
  assert.equal(v.rawBucket, undefined);
  assert.equal(v.rawS3Key, undefined);
  assert.match(v.streamingUrl, new RegExp(`${VIDEO_A}/master.m3u8$`));
  assert.deepEqual(v.qualities.map((q) => q.premiumOnly), [true, false]);
  assert.match(v.qualities[0].playlistUrl, /hd\/1080p\.m3u8$/);
  assert.equal(toPublicVideo({ videoId: VIDEO_A, status: 'PROCESSING' }).streamingUrl, null);
});

test('CloudFront invalidation covers the viewer path and the rewritten cache key', () => {
  assert.deepEqual(videoInvalidationPaths(VIDEO_A, 'https://d1.cloudfront.net/videos'), [`/videos/${VIDEO_A}/*`, `/${VIDEO_A}/*`]);
});

test('write endpoints require login', async () => {
  assert.equal((await call('GET', '/api/videos/mine')).status, 401);
  assert.equal((await call('PUT', `/api/videos/${VIDEO_A}/rating`, { body: { stars: 5 } })).status, 401);
  assert.equal((await call('DELETE', `/api/videos/${VIDEO_A}`)).status, 401);
});

test('catalog against PostgreSQL', { skip: process.env.DB_TEST !== '1' && 'set DB_TEST=1 to run' }, async (t) => {
  execFileSync(process.execPath, ['src/migrate.js'], { stdio: 'inherit', env: process.env });
  const repo = await import('../src/repository.js');
  const { handleEvent } = await import('../src/projector.js');

  const owner = issueDevToken({ email: `owner-${crypto.randomUUID()}@example.com`, tier: 'free' });
  const ownerSub = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url')).sub;
  const premium = issueDevToken({ email: 'p@example.com', tier: 'premium' });
  const stranger = issueDevToken({ email: 's@example.com', tier: 'free' });

  const ev = (type, detail) => ({ id: crypto.randomUUID(), type, detail });
  const facts = (id, i, tier) => ({
    videoId: id,
    ownerId: ownerSub,
    title: `video ${i}`,
    tier,
    originalFileName: `v${i}.mp4`,
    contentType: 'video/mp4',
    fileSize: 1000 + i,
    rawBucket: 'raw',
    rawS3Key: `raw/${id}/source.mp4`,
    processedBucket: 'processed',
  });

  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    assert.equal(await handleEvent(ev('VideoCreated', facts(id, i, i % 2 ? 'premium' : 'free'))), 'applied');
  }
  t.after(async () => {
    for (const id of ids) await repo.db.query('DELETE FROM videos WHERE video_id = $1', [id]);
    await repo.db.pool.end();
  });

  await t.test('events arriving out of order end in the right state', async () => {
    const id = ids[0];
    const completed = ev('TranscodeCompleted', {
      videoId: id,
      duration: 6,
      qualities: [{ resolution: '720p', path: 'sd/720p.m3u8', width: 1280, height: 720 }],
    });
    assert.equal(await handleEvent(ev('VideoUploaded', facts(id, 0, 'free'))), 'applied');
    assert.equal(await handleEvent(completed), 'applied');
    assert.equal(await handleEvent(ev('TranscodeStarted', { videoId: id, attempt: 1 })), 'ignored', 'late start does not undo READY');
    assert.equal(await handleEvent(completed), 'duplicate', 'same event id is processed once');
    const v = await repo.getVideoById(id);
    assert.equal(v.status, 'READY');
    assert.equal(v.duration, 6);
  });

  await t.test('event for a video the catalog has not seen yet is retried later', async () => {
    const unknown = crypto.randomUUID();
    await assert.rejects(handleEvent(ev('TranscodeStarted', { videoId: unknown })), { name: 'RetryLaterError' });
    // Bị huỷ cả ghi nhận sự kiện: lần giao lại vẫn được xử lý
    assert.equal(await repo.isDeleted(unknown), false);
  });

  await t.test('failures: retry keeps PROCESSING, final marks FAILED', async () => {
    const id = ids[1];
    await handleEvent(ev('VideoUploaded', facts(id, 1, 'premium')));
    await handleEvent(ev('TranscodeFailed', { videoId: id, attempt: 1, final: false, error: 'S3 timeout' }));
    assert.equal((await repo.getVideoById(id)).status, 'PROCESSING');
    await handleEvent(ev('TranscodeFailed', { videoId: id, attempt: 3, final: true, error: 'bad file' }));
    const v = await repo.getVideoById(id);
    assert.equal(v.status, 'FAILED');
    assert.equal(v.errorMessage, 'bad file');
  });

  await t.test('views, ratings and access', async () => {
    const id = ids[0];
    await handleEvent(ev('VideoViewed', { videoId: id }));
    await handleEvent(ev('VideoViewed', { videoId: id }));
    assert.equal((await repo.getVideoById(id)).viewCount, 2);

    const rate = (token, stars, vid = id) => call('PUT', `/api/videos/${vid}/rating`, { token, body: { stars } });
    assert.deepEqual((await rate(premium, 5)).body.data, { ratingAvg: 5, ratingCount: 1, myRating: 5 });
    assert.deepEqual((await rate(owner, 4)).body.data, { ratingAvg: 4.5, ratingCount: 2, myRating: 4 });
    assert.equal((await rate(owner, 9)).status, 400);
    const detail = await call('GET', `/api/videos/${id}`, { token: owner });
    assert.equal(detail.body.data.myRating, 4);

    // Video premium READY của owner: người lạ gói free không chấm được, owner thì được
    const pid = ids[3];
    await handleEvent(ev('TranscodeCompleted', { videoId: pid, duration: 3, qualities: [] }));
    assert.equal((await rate(stranger, 1, pid)).status, 403);
    assert.equal((await rate(owner, 5, pid)).status, 200);
  });

  await t.test('list filters, sorts and "mine"', async () => {
    const mine = await call('GET', '/api/videos/mine?limit=10', { token: owner });
    assert.deepEqual(new Set(mine.body.data.map((v) => v.videoId)), new Set(ids));
    const ready = await call('GET', '/api/videos?status=READY&sort=views&limit=100');
    const order = ready.body.data.map((v) => v.videoId);
    assert.ok(order.indexOf(ids[0]) < order.indexOf(ids[3]), 'more views first');
    const premiumOnly = await call('GET', '/api/videos?tier=premium&limit=100');
    assert.ok(premiumOnly.body.data.every((v) => v.tier === 'premium'));
  });

  await t.test('delete: owner only, then late events are dropped', async () => {
    const id = ids[2];
    assert.equal((await call('DELETE', `/api/videos/${id}`, { token: stranger })).status, 403);
    assert.equal((await call('DELETE', `/api/videos/${id}`, { token: owner })).status, 200);
    assert.deepEqual(purged, [id]);
    assert.equal((await call('GET', `/api/videos/${id}`)).status, 404);
    let cleaned = null;
    const late = await handleEvent(
      ev('TranscodeCompleted', { videoId: id, processedBucket: 'processed', qualities: [] }),
      { purge: async (v) => (cleaned = v.videoId) }
    );
    assert.equal(late, 'deleted');
    assert.equal(cleaned, id, 'HLS written after delete is removed');
    assert.equal(await repo.getVideoById(id), null, 'not recreated');
  });

  await t.test('internal endpoint gives playback what it needs', async () => {
    const r = await call('GET', `/internal/videos/${ids[3]}`);
    assert.deepEqual(Object.keys(r.body.data).sort(), ['ownerId', 'qualities', 'status', 'tier', 'videoId']);
  });
});
