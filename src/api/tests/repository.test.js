// Test tích hợp với PostgreSQL thật. Chạy khi DB_TEST=1 (CI có service postgres; local:
//   docker run -d --name sf-pg -e POSTGRES_USER=streamforge -e POSTGRES_PASSWORD=streamforge -p 5432:5432 postgres:17-alpine
//   DB_TEST=1 npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const enabled = process.env.DB_TEST === '1';

test('video repository against PostgreSQL', { skip: !enabled && 'set DB_TEST=1 to run' }, async (t) => {
  process.env.AWS_ACCESS_KEY_ID ||= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ||= 'test';
  execFileSync(process.execPath, ['src/db/migrate.js'], { stdio: 'inherit', env: process.env });

  const repo = await import('../src/services/videoRepository.js');
  const { pool } = await import('../src/db/pool.js');

  const owner = `test-${crypto.randomUUID()}`;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await repo.createVideoRecord({
      videoId: id,
      title: `video ${i}`,
      originalFileName: `v${i}.mp4`,
      contentType: 'video/mp4',
      fileSize: 1000 + i,
      ownerId: owner,
      tier: i % 2 ? 'premium' : 'free',
      rawS3Key: `raw/${id}/source.mp4`,
    });
  }
  t.after(async () => {
    for (const id of ids) await repo.deleteVideoRecord(id);
    await pool.end();
  });

  await t.test('create and read back', async () => {
    const v = await repo.getVideoById(ids[0]);
    assert.equal(v.status, 'UPLOADING');
    assert.equal(v.fileSize, 1000);
    assert.equal(v.ownerId, owner);
    assert.equal(await repo.getVideoById(crypto.randomUUID()), null);
  });

  await t.test('conditional status updates', async () => {
    const v = await repo.updateVideoStatus(ids[0], 'PROCESSING', { attempt: 1 }, { expectedStatus: 'UPLOADING' });
    assert.equal(v.status, 'PROCESSING');
    await assert.rejects(
      repo.updateVideoStatus(ids[0], 'PROCESSING', {}, { expectedStatus: 'UPLOADING' }),
      { name: 'ConflictError' }
    );
    await assert.rejects(repo.updateVideoStatus(ids[0], 'DELETING', {}, { notStatus: 'PROCESSING' }), {
      name: 'ConflictError',
    });
    const ready = await repo.updateVideoStatus(ids[0], 'READY', {
      duration: 6,
      qualities: [{ resolution: '720p', width: 720, height: 1280 }],
      processedAt: new Date().toISOString(),
      notAColumn: 'ignored',
    });
    assert.deepEqual(ready.qualities, [{ resolution: '720p', width: 720, height: 1280 }]);
    assert.equal(ready.duration, 6);
  });

  await t.test('keyset pagination returns full pages in newest-first order', async () => {
    const seen = [];
    let startKey;
    do {
      const page = await repo.listVideos({ limit: 2, startKey, ownerId: owner });
      assert.ok(page.items.length === 2 || !page.lastKey);
      seen.push(...page.items.map((v) => v.videoId));
      startKey = page.lastKey;
    } while (startKey);
    assert.deepEqual(seen, [...ids].reverse());
  });

  await t.test('status filter still fills pages', async () => {
    const page = await repo.listVideos({ limit: 3, status: 'UPLOADING', ownerId: owner });
    assert.equal(page.items.length, 3);
    assert.ok(page.items.every((v) => v.status === 'UPLOADING'));
  });

  await t.test('tier filter', async () => {
    const page = await repo.listVideos({ limit: 10, tier: 'premium', ownerId: owner });
    assert.deepEqual(page.items.map((v) => v.videoId), [ids[3], ids[1]]);
  });

  await t.test('views counter and sort by views pages through every video once', async () => {
    // ids[2] 3 lượt, ids[4] 1 lượt, còn lại 0: thứ tự views rồi mới nhất trước
    for (let i = 0; i < 3; i++) await repo.incrementViews(ids[2]);
    assert.equal(await repo.incrementViews(ids[4]), 1);
    const seen = [];
    let startKey;
    do {
      const page = await repo.listVideos({ limit: 2, startKey, ownerId: owner, sort: 'views' });
      seen.push(...page.items.map((v) => v.videoId));
      startKey = page.lastKey;
    } while (startKey);
    assert.deepEqual(seen, [ids[2], ids[4], ids[3], ids[1], ids[0]]);
    assert.equal((await repo.getVideoById(ids[2])).viewCount, 3);
  });

  await t.test('ratings: one per user, average kept in sync, sort by rating', async () => {
    await repo.rateVideo(ids[1], 'alice', 5);
    await repo.rateVideo(ids[1], 'bob', 4);
    const again = await repo.rateVideo(ids[1], 'bob', 2); // chấm lại thì ghi đè
    assert.deepEqual(again, { ratingAvg: 3.5, ratingCount: 2, myRating: 2 });
    await repo.rateVideo(ids[3], 'alice', 4);
    assert.equal(await repo.getUserRating(ids[1], 'bob'), 2);
    assert.equal(await repo.getUserRating(ids[1], 'carol'), null);

    const page = await repo.listVideos({ limit: 1, ownerId: owner, sort: 'rating' });
    assert.equal(page.items[0].videoId, ids[3]);
    const next = await repo.listVideos({ limit: 10, ownerId: owner, sort: 'rating', startKey: page.lastKey });
    assert.deepEqual(next.items.map((v) => v.videoId), [ids[1], ids[4], ids[2], ids[0]]);
  });

  await t.test('oldest first and period filter', async () => {
    const page = await repo.listVideos({ limit: 10, ownerId: owner, sort: 'oldest' });
    assert.deepEqual(page.items.map((v) => v.videoId), ids);
    const recent = await repo.listVideos({ limit: 10, ownerId: owner, period: 'day' });
    assert.equal(recent.items.length, 5);
  });
});
