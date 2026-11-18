import test from 'node:test';
import assert from 'node:assert/strict';

const { canWatch, canWatchHd, canManage, qualityHeight } = await import('../src/access.js');
const { issueDevToken, verifyToken, resolveAuth } = await import('../src/auth.js');
const { createRateLimiter } = await import('../src/rateLimit.js');

test('premium videos: premium users, admins and the owner', () => {
  assert.ok(canWatch({ tier: 'free' }, { tier: 'free' }));
  assert.ok(!canWatch({ tier: 'free', sub: 'u1' }, { tier: 'premium', ownerId: 'u2' }));
  assert.ok(!canWatch({ tier: 'free', sub: 'u1' }, { tier: 'premium' }), 'no owner does not mean everyone');
  assert.ok(canWatch({ tier: 'free', sub: 'u1' }, { tier: 'premium', ownerId: 'u1' }));
  assert.ok(canWatch({ tier: 'premium' }, { tier: 'premium' }));
  assert.ok(canWatch({ tier: 'free', admin: true }, { tier: 'premium' }));
});

test('only premium and admin get renditions above 720p', () => {
  assert.equal(canWatchHd({ tier: 'free' }), false);
  assert.equal(canWatchHd({ tier: 'premium' }), true);
  assert.equal(canWatchHd({ tier: 'free', admin: true }), true);
  assert.equal(qualityHeight('1080p'), 1080);
});

test('manage: owner or admin only', () => {
  assert.ok(canManage({ sub: 'u1' }, { ownerId: 'u1' }));
  assert.ok(!canManage({ sub: 'u1' }, { ownerId: 'u2' }));
  assert.ok(!canManage({ sub: 'u1' }, {}), 'videos without owner need an admin');
  assert.ok(canManage({ sub: 'u1', admin: true }, { ownerId: 'u2' }));
});

test('dev tokens: stable subject per email, verified by every service', async () => {
  const a = await verifyToken(issueDevToken({ email: 'A@example.com', tier: 'premium' }));
  const b = await verifyToken(issueDevToken({ email: 'a@example.com', tier: 'free' }));
  assert.equal(a.sub, b.sub);
  assert.equal(a.tier, 'premium');
  await assert.rejects(verifyToken('garbage'));
});

test('production refuses dev auth unless explicitly allowed', () => {
  assert.throws(() => resolveAuth({ NODE_ENV: 'production' }), /COGNITO_USER_POOL_ID/);
  assert.throws(() => resolveAuth({ NODE_ENV: 'production', ALLOW_DEV_AUTH: 'true', JWT_SECRET: 'short' }), /32/);
  assert.equal(resolveAuth({ COGNITO_USER_POOL_ID: 'us-east-1_abc', COGNITO_CLIENT_ID: 'c' }).region, 'us-east-1');
});

test('rate limiter blocks after max requests per window', () => {
  let t = 0;
  const limit = createRateLimiter({ max: 2, windowSeconds: 60, now: () => t });
  const run = () => {
    let status = 200;
    const res = { setHeader() {}, status(c) { status = c; return this; }, json() {} };
    limit({ ip: '1.2.3.4' }, res, () => {});
    return status;
  };
  assert.deepEqual([run(), run(), run()], [200, 200, 429]);
  t = 61_000;
  assert.equal(run(), 200, 'new window');
});

test('fault injection fails only /api requests, and only when enabled', async () => {
  const { createHttpApp } = await import('../src/http.js');
  const { createMetrics } = await import('../src/metrics.js');
  const routes = (app) => app.get('/api/ping', (req, res) => res.json({ ok: true }));
  const listen = (opts) => createHttpApp({ service: 'faulty', metrics: createMetrics('faulty'), routes, ...opts }).listen(0);
  const get = async (server, path) => (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).status;

  const off = listen({ faultRate: 0 });
  const on = listen({ faultRate: 0.5, random: () => 0.1 });
  const lucky = listen({ faultRate: 0.5, random: () => 0.9 });
  try {
    assert.equal(await get(off, '/api/ping'), 200);
    assert.equal(await get(on, '/api/ping'), 500);
    assert.equal(await get(on, '/health'), 200, 'health checks never fail');
    assert.equal(await get(lucky, '/api/ping'), 200);
  } finally {
    off.close();
    on.close();
    lucky.close();
  }
});
