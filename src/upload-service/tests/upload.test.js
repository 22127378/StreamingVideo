// Test không cần database chạy mặc định. Phần dùng PostgreSQL thật chạy khi DB_TEST=1
// (CI có service postgres; local: docker compose up -d postgres rồi DB_TEST=1 npm test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

process.env.AWS_ACCESS_KEY_ID ||= 'test';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test';
process.env.AWS_ENDPOINT_URL ||= 'http://localhost:4566';

const { issueDevToken } = await import('@streamforge/shared/auth');
const { rawKeyFor, presignUpload } = await import('../src/s3.js');
const { createApp } = await import('../src/app.js');

const published = [];
const files = new Map();
const app = createApp({
  rateLimit: { max: 0 },
  publish: async (service, type, detail) => published.push({ service, type, detail }),
  head: async (bucket, key) => (files.has(key) ? { exists: true, contentLength: files.get(key) } : { exists: false }),
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const alice = issueDevToken({ email: 'alice@example.com', tier: 'free' });
const bob = issueDevToken({ email: 'bob@example.com', tier: 'free' });

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

test('raw key is raw/{id}/source.{ext} with a safe extension', () => {
  assert.equal(rawKeyFor('abc', 'clip.MOV'), 'raw/abc/source.mov');
  assert.equal(rawKeyFor('abc', 'clip.mp4/../../etc'), 'raw/abc/source.mp4');
  assert.equal(rawKeyFor('abc', 'noext'), 'raw/abc/source.mp4');
});

test('presigned URL signs size and type', async () => {
  const r = await presignUpload({ videoId: 'v', key: 'raw/v/source.mp4', fileName: 'a.mp4', contentType: 'video/mp4', fileSize: 1234 });
  const signed = new URL(r.uploadUrl).searchParams.get('X-Amz-SignedHeaders').split(';');
  assert.ok(signed.includes('content-length') && signed.includes('content-type'));
  assert.deepEqual(r.uploadHeaders, { 'Content-Type': 'video/mp4', 'Content-Length': '1234' });
});

test('upload endpoints require login and valid input', async () => {
  assert.equal((await call('POST', '/api/uploads', { body: {} })).status, 401);
  const bad = [
    { fileName: 'a.mp4', contentType: 'video/mp4' },
    { fileName: 'a.txt', contentType: 'text/plain', fileSize: 10 },
    { fileName: 'a.mp4', contentType: 'video/mp4', fileSize: 10, tier: 'gold' },
  ];
  for (const body of bad) assert.equal((await call('POST', '/api/uploads', { body, token: alice })).status, 400);
  assert.equal((await call('POST', '/api/uploads/not-a-uuid/complete', { token: alice })).status, 400);
});

test('upload flow against PostgreSQL', { skip: process.env.DB_TEST !== '1' && 'set DB_TEST=1 to run' }, async (t) => {
  execFileSync(process.execPath, ['src/migrate.js'], { stdio: 'inherit', env: process.env });
  const { db } = await import('../src/repository.js');
  t.after(() => db.pool.end());

  const created = await call('POST', '/api/uploads', {
    token: alice,
    body: { fileName: 'trip.mp4', contentType: 'video/mp4', fileSize: 5000, title: 'Trip', tier: 'premium' },
  });
  assert.equal(created.status, 201);
  const { videoId, upload } = created.body.data;
  assert.equal(upload.status, 'UPLOADING');
  assert.equal(published.at(-1).type, 'VideoCreated');
  assert.equal(published.at(-1).detail.tier, 'premium');

  const complete = (token) => call('POST', `/api/uploads/${videoId}/complete`, { token });
  assert.equal((await complete(bob)).status, 403, 'only the owner completes');
  assert.equal((await complete(alice)).status, 400, 'file not on S3 yet');

  files.set(upload.rawS3Key, 4800);
  const done = await complete(alice);
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, 'COMPLETED');
  assert.equal(done.body.data.fileSize, 4800, 'size from S3, not from the client');
  const job = published.at(-1);
  assert.equal(job.type, 'VideoUploaded');
  assert.deepEqual(job.detail.targetResolutions, ['1080p', '720p', '480p', '360p']);
  assert.equal(job.detail.rawS3Key, upload.rawS3Key);

  assert.equal((await complete(alice)).status, 409, 'second complete is rejected');
  await db.query('DELETE FROM uploads WHERE video_id = $1', [videoId]);
});
