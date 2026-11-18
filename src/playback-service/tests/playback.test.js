import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { issueDevToken } = await import('@streamforge/shared/auth');
const { createApp, config } = await import('../src/app.js');
const { signedPlaybackCookies } = await import('../src/cookies.js');

const OWNER = issueDevToken({ email: 'owner@example.com', tier: 'free' });
const OWNER_SUB = JSON.parse(Buffer.from(OWNER.split('.')[1], 'base64url')).sub;
const FREE = issueDevToken({ email: 'free@example.com', tier: 'free' });
const PREMIUM = issueDevToken({ email: 'premium@example.com', tier: 'premium' });

const tiered = [
  { resolution: '1080p', path: 'hd/1080p.m3u8' },
  { resolution: '720p', path: 'sd/720p.m3u8' },
];
const videos = {
  'aaaaaaaa-0000-4000-8000-000000000001': { tier: 'premium', ownerId: OWNER_SUB, status: 'READY', qualities: tiered },
  'aaaaaaaa-0000-4000-8000-000000000002': { tier: 'free', ownerId: 'x', status: 'READY', qualities: tiered },
  'aaaaaaaa-0000-4000-8000-000000000003': { tier: 'free', ownerId: 'x', status: 'PROCESSING', qualities: [] },
};
const [PREMIUM_VIDEO, FREE_VIDEO, PROCESSING_VIDEO] = Object.keys(videos);
const views = [];

const server = createApp({
  getVideo: async (id) => (videos[id] ? { videoId: id, ...videos[id] } : null),
  publish: async (service, type, detail) => views.push(detail.videoId),
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const play = async (id, token) => {
  const res = await fetch(`${base}/api/playback/${id}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
};

test('access rules', async () => {
  assert.equal((await play(FREE_VIDEO)).status, 401);
  assert.equal((await play('nope', FREE)).status, 400);
  assert.equal((await play(crypto.randomUUID(), FREE)).status, 404);
  assert.equal((await play(PROCESSING_VIDEO, FREE)).status, 409);
  assert.equal((await play(PREMIUM_VIDEO, FREE)).status, 403, 'free user, premium video of someone else');
  assert.equal((await play(PREMIUM_VIDEO, OWNER)).status, 200, 'owner watches own premium upload');
  assert.equal((await play(PREMIUM_VIDEO, PREMIUM)).status, 200);
});

test('free users get the 720p master, premium the full one; views are published', async () => {
  views.length = 0;
  const free = await play(FREE_VIDEO, FREE);
  assert.match(free.body.data.streamingUrl, /\/sd\/master\.m3u8$/);
  assert.deepEqual(free.body.data.lockedQualities, ['1080p']);
  assert.equal(free.body.data.maxHeight, 720);
  const premium = await play(FREE_VIDEO, PREMIUM);
  assert.match(premium.body.data.streamingUrl, new RegExp(`${FREE_VIDEO}/master\\.m3u8$`));
  assert.deepEqual(premium.body.data.lockedQualities, []);
  assert.deepEqual(views, [FREE_VIDEO, FREE_VIDEO]);
});

test('signed cookie policy is scoped to the video and to sd/ for free users', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const opts = {
    keyPairId: 'K2TEST',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    cdnBaseUrl: 'https://d1.cloudfront.net/videos',
    ttlSeconds: config.ttlSeconds,
    now: Date.UTC(2026, 10, 17),
  };
  const decode = (c) => JSON.parse(Buffer.from(c['CloudFront-Policy'].replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64').toString());
  const full = signedPlaybackCookies(FREE_VIDEO, opts);
  assert.equal(full.path, `/videos/${FREE_VIDEO}/`);
  assert.equal(decode(full.cookies).Statement[0].Resource, `https://d1.cloudfront.net/videos/${FREE_VIDEO}/*`);
  const sd = signedPlaybackCookies(FREE_VIDEO, { ...opts, hd: false });
  assert.equal(decode(sd.cookies).Statement[0].Resource, `https://d1.cloudfront.net/videos/${FREE_VIDEO}/sd/*`);
  assert.equal(signedPlaybackCookies(FREE_VIDEO, { ...opts, keyPairId: '' }), null, 'no key locally');
});
