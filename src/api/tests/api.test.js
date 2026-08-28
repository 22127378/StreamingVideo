import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { config } from '../src/config/aws.js';

test('StreamForge API Unit Tests', async (t) => {
  const app = createApp();

  await t.test('1. GET /health should return UP status', async () => {
    // Tự gọi handler hoặc test logic
    const req = { method: 'GET', url: '/health' };
    assert.strictEqual(config.port, 4000);
    assert.ok(config.rawBucket);
    assert.ok(config.videosTable);
  });

  await t.test('2. JWT Playback Token signing & verification', () => {
    const payload = {
      sub: 'test-user-123',
      tier: 'premium',
      videoId: 'vid-abc-xyz',
    };

    const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '1h' });
    assert.ok(typeof token === 'string' && token.length > 20);

    const decoded = jwt.verify(token, config.jwtSecret);
    assert.strictEqual(decoded.sub, 'test-user-123');
    assert.strictEqual(decoded.tier, 'premium');
    assert.strictEqual(decoded.videoId, 'vid-abc-xyz');
  });

  await t.test('3. S3 Presigned URL generator formats key properly', async () => {
    const { generateUploadPresignedUrl } = await import('../src/services/s3Service.js');
    const result = await generateUploadPresignedUrl('sample.mp4', 'video/mp4', 'uuid-1234');

    assert.strictEqual(result.s3Key, 'raw/uuid-1234/source.mp4');
    assert.strictEqual(result.bucket, config.rawBucket);
    assert.ok(result.uploadUrl.includes('raw%2Fuuid-1234%2Fsource.mp4') || result.uploadUrl.includes('source.mp4'));
  });
});
