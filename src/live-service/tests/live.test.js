// Test API của live-service với repo trong bộ nhớ và provider giả: không cần PostgreSQL, IVS hay MediaMTX.
// Câu SQL trong repository.js được kiểm tra bằng CI (DB_TEST=1) ở phần cuối file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

process.env.AWS_ACCESS_KEY_ID ||= 'test';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test';
process.env.LIVE_CHAT_COOLDOWN_MS = '1000';

const { issueDevToken } = await import('@streamforge/shared/auth');
const { createApp } = await import('../src/app.js');
const { cachedLiveStatus, createLocalProvider } = await import('../src/providers.js');
const { nameFromEmail, createNameResolver } = await import('../src/names.js');

function memoryRepo() {
  const channels = new Map();
  const subs = new Set(); // `${channelId}|${userId}`
  const messages = [];
  let nextId = 1;
  const withViewer = (c, viewerId) => c && { ...c, subscribed: subs.has(`${c.channelId}|${viewerId}`) };
  const toMessage = (m) => ({
    ...m,
    subscriber: subs.has(`${m.channelId}|${m.userId}`),
    owner: channels.get(m.channelId)?.ownerId === m.userId,
  });
  return {
    channels,
    async listChannels({ viewerId }) {
      return [...channels.values()].map((c) => withViewer(c, viewerId));
    },
    async getChannel(id, viewerId = null) {
      return withViewer(channels.get(id), viewerId);
    },
    async getChannelByOwner(ownerId) {
      return [...channels.values()].find((c) => c.ownerId === ownerId) || null;
    },
    async insertChannel(c) {
      if ([...channels.values()].some((x) => x.ownerId === c.ownerId)) return null;
      const row = { ...c, subscriberCount: 0 };
      channels.set(c.channelId, row);
      return row;
    },
    async updateChannel(id, patch) {
      const c = channels.get(id);
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null) c[k] = v;
      return c;
    },
    async setSubscription(channelId, userId, subscribed) {
      const key = `${channelId}|${userId}`;
      const c = channels.get(channelId);
      if (subscribed && !subs.has(key)) {
        subs.add(key);
        c.subscriberCount += 1;
      } else if (!subscribed && subs.delete(key)) {
        c.subscriberCount -= 1;
      }
      return c.subscriberCount;
    },
    async addMessage(m) {
      const row = { messageId: nextId++, ...m, createdAt: new Date().toISOString() };
      messages.push(row);
      return toMessage(row);
    },
    async listMessages(channelId, { after, limit }) {
      const all = messages.filter((m) => m.channelId === channelId).map(toMessage);
      return after === undefined ? all.slice(-limit) : all.filter((m) => m.messageId > after).slice(0, limit);
    },
    async deleteMessage(channelId, messageId) {
      const i = messages.findIndex((m) => m.channelId === channelId && m.messageId === messageId);
      if (i < 0) return false;
      messages.splice(i, 1);
      return true;
    },
  };
}

const repo = memoryRepo();
const live = new Map();
let clock = 1_000_000;
const provider = {
  ...createLocalProvider({ fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }) }),
  liveChannels: async () => live,
};
const server = createApp({ repo, provider, liveStatus: async () => live, now: () => clock }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const streamer = issueDevToken({ email: 'streamer@example.com', tier: 'free' });
const fan = issueDevToken({ email: 'fan@example.com', tier: 'free' });
const guest = issueDevToken({ email: 'guest@example.com', tier: 'premium' });

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let channel;

test('studio requires login and creates one channel per user', async () => {
  assert.equal((await call('GET', '/api/live/studio')).status, 401);
  assert.equal((await call('GET', '/api/live/studio', { token: streamer })).status, 404);

  const created = await call('POST', '/api/live/studio', { token: streamer, body: { title: 'Học Kubernetes' } });
  assert.equal(created.status, 201);
  channel = created.body.data;
  assert.equal(channel.title, 'Học Kubernetes');
  assert.equal(channel.ownerName, 'streamer');
  assert.match(channel.ingestEndpoint, /^rtmp:\/\//);
  assert.match(channel.streamKey, new RegExp(`^${channel.channelId}\\?key=[0-9a-f]{32}$`));

  const again = await call('POST', '/api/live/studio', { token: streamer, body: { title: 'khác' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.channelId, channel.channelId);
  assert.equal(repo.channels.size, 1);
});

test('public channel data never exposes the stream key or ingest address', async () => {
  const { body } = await call('GET', `/api/live/channels/${channel.channelId}`);
  assert.equal(body.data.streamKey, undefined);
  assert.equal(body.data.ingestEndpoint, undefined);
  assert.equal(body.data.isLive, false);
  const list = await call('GET', '/api/live/channels');
  assert.equal(JSON.stringify(list.body).includes(repo.channels.get(channel.channelId).streamKeyRef), false);
});

test('live status comes from the provider and live channels sort first', async () => {
  const other = await call('POST', '/api/live/studio', { token: guest, body: { title: 'Offline' } });
  live.set(`live/${channel.channelId}`, { viewerCount: 7, startedAt: '2026-11-19T00:00:00.000Z' });
  const { body } = await call('GET', '/api/live/channels');
  assert.equal(body.data[0].channelId, channel.channelId);
  assert.equal(body.data[0].isLive, true);
  assert.equal(body.data[0].viewerCount, 7);
  assert.equal(body.data[1].channelId, other.body.data.channelId);
  assert.equal(body.data[1].isLive, false);
});

test('subscribe, count, idempotency and no self-subscription', async () => {
  const path = `/api/live/channels/${channel.channelId}/subscription`;
  assert.equal((await call('PUT', path)).status, 401);
  assert.equal((await call('PUT', path, { token: streamer })).status, 400);

  let res = await call('PUT', path, { token: fan });
  assert.deepEqual(res.body.data, { subscribed: true, subscriberCount: 1 });
  res = await call('PUT', path, { token: fan });
  assert.equal(res.body.data.subscriberCount, 1);

  const detail = await call('GET', `/api/live/channels/${channel.channelId}`, { token: fan });
  assert.equal(detail.body.data.subscribed, true);
  const anon = await call('GET', `/api/live/channels/${channel.channelId}`);
  assert.equal(anon.body.data.subscribed, false);
});

test('chat shows subscriber and owner badges', async () => {
  const path = `/api/live/channels/${channel.channelId}/messages`;
  assert.equal((await call('POST', path, { body: { body: 'hi' } })).status, 401);
  assert.equal((await call('POST', path, { token: fan, body: { body: '   ' } })).status, 400);
  assert.equal((await call('POST', path, { token: fan, body: { body: 'x'.repeat(301) } })).status, 400);

  const fromFan = await call('POST', path, { token: fan, body: { body: 'Chào mọi người' } });
  assert.equal(fromFan.status, 201);
  assert.equal(fromFan.body.data.userName, 'fan');
  assert.equal(fromFan.body.data.subscriber, true);
  assert.equal(fromFan.body.data.owner, false);

  const fromGuest = await call('POST', path, { token: guest, body: { body: 'Xin chào' } });
  assert.equal(fromGuest.body.data.subscriber, false);

  const fromOwner = await call('POST', path, { token: streamer, body: { body: 'Cảm ơn đã xem' } });
  assert.equal(fromOwner.body.data.owner, true);

  const all = await call('GET', path);
  assert.deepEqual(
    all.body.data.map((m) => [m.userName, m.subscriber, m.owner]),
    [
      ['fan', true, false],
      ['guest', false, false],
      ['streamer', false, true],
    ]
  );
  // Hỏi tiếp từ id cuối: chỉ nhận bình luận mới
  const after = all.body.data[0].messageId;
  assert.equal((await call('GET', `${path}?after=${after}`)).body.data.length, 2);
});

test('badge follows the current subscription', async () => {
  await call('DELETE', `/api/live/channels/${channel.channelId}/subscription`, { token: fan });
  const { body } = await call('GET', `/api/live/channels/${channel.channelId}/messages`);
  assert.equal(body.data.find((m) => m.userName === 'fan').subscriber, false);
  assert.equal((await call('GET', `/api/live/channels/${channel.channelId}`)).body.data.subscriberCount, 0);
});

test('chat cooldown per user', async () => {
  const path = `/api/live/channels/${channel.channelId}/messages`;
  clock += 5_000;
  assert.equal((await call('POST', path, { token: guest, body: { body: 'một' } })).status, 201);
  assert.equal((await call('POST', path, { token: guest, body: { body: 'hai' } })).status, 429);
  clock += 1_000;
  assert.equal((await call('POST', path, { token: guest, body: { body: 'ba' } })).status, 201);
});

test('only the channel owner deletes chat messages', async () => {
  const path = `/api/live/channels/${channel.channelId}/messages`;
  const { body } = await call('GET', path);
  const target = body.data[0].messageId;
  assert.equal((await call('DELETE', `${path}/${target}`, { token: fan })).status, 403);
  assert.equal((await call('DELETE', `${path}/${target}`, { token: streamer })).status, 200);
  assert.equal((await call('DELETE', `${path}/${target}`, { token: streamer })).status, 404);
});

test('MediaMTX publish auth checks the stream key', async () => {
  const key = repo.channels.get(channel.channelId).streamKeyRef;
  const auth = (payload) => call('POST', '/internal/live/auth', { body: payload });
  const path = `live/${channel.channelId}`;
  assert.equal((await auth({ action: 'read', path })).status, 200);
  assert.equal((await auth({ action: 'publish', path, query: `key=${key}` })).status, 200);
  assert.equal((await auth({ action: 'publish', path, query: 'key=wrong' })).status, 401);
  assert.equal((await auth({ action: 'publish', path })).status, 401);
  assert.equal((await auth({ action: 'publish', path: 'live/other', query: `key=${key}` })).status, 401);
  assert.equal((await auth({ action: 'api', path })).status, 401);
});

test('resetting the stream key invalidates the old one', async () => {
  const before = (await call('GET', '/api/live/studio', { token: streamer })).body.data.streamKey;
  const after = (await call('POST', '/api/live/studio/stream-key', { token: streamer })).body.data.streamKey;
  assert.notEqual(before, after);
  const oldKey = new URLSearchParams(before.split('?')[1]).get('key');
  const res = await call('POST', '/internal/live/auth', {
    body: { action: 'publish', path: `live/${channel.channelId}`, query: `key=${oldKey}` },
  });
  assert.equal(res.status, 401);
});

test('rejects malformed ids', async () => {
  assert.equal((await call('GET', '/api/live/channels/abc')).status, 400);
  assert.equal((await call('GET', '/api/live/channels/abc/messages')).status, 400);
  assert.equal((await call('GET', `/api/live/channels/${channel.channelId}/messages?after=-1`)).status, 400);
});

test('status cache keeps the last good value when the provider fails', async () => {
  let t = 0;
  let calls = 0;
  let fail = false;
  const status = cachedLiveStatus(
    {
      liveChannels: async () => {
        calls += 1;
        if (fail) throw new Error('down');
        return new Map([['a', { viewerCount: 1 }]]);
      },
    },
    { ttlMs: 10_000, now: () => t }
  );
  assert.equal((await status()).size, 1);
  assert.equal((await status()).size, 1);
  assert.equal(calls, 1);
  fail = true;
  t = 20_000;
  assert.equal((await status()).size, 1);
  assert.equal(calls, 2);
});

test('display names hide the email domain and fall back without Cognito', async () => {
  assert.equal(nameFromEmail('alice.nguyen@example.com'), 'alice.nguyen');
  const resolve = createNameResolver({ lookup: async () => 'bob@example.com' });
  assert.equal(await resolve({ sub: 'abc', username: 'abc' }), 'bob');
  const failing = createNameResolver({ lookup: async () => Promise.reject(new Error('x')) });
  assert.equal(await failing({ sub: '123456789' }), 'user-123456');
});

// ---------------- PostgreSQL thật (CI: DB_TEST=1, DB_USER=streamforge_live, DB_SCHEMA=live)
test('repository SQL against PostgreSQL', { skip: process.env.DB_TEST !== '1' }, async () => {
  execFileSync(process.execPath, ['src/migrate.js'], { stdio: 'inherit', env: process.env });
  const real = await import('../src/repository.js');
  const id = crypto.randomUUID();
  const owner = `owner-${id}`;
  try {
    const c = await real.insertChannel({
      channelId: id,
      ownerId: owner,
      ownerName: 'owner',
      title: 't',
      provider: 'local',
      providerChannelId: `live/${id}`,
      ingestEndpoint: 'rtmp://x/live',
      playbackUrl: 'http://x',
      streamKeyRef: 'k',
    });
    assert.equal(c.channelId, id);
    assert.equal(await real.insertChannel({ ...c, channelId: crypto.randomUUID(), providerChannelId: 'other' }), null);

    assert.equal(await real.setSubscription(id, 'fan', true), 1);
    assert.equal(await real.setSubscription(id, 'fan', true), 1);
    assert.equal((await real.getChannel(id, 'fan')).subscribed, true);

    const m1 = await real.addMessage({ channelId: id, userId: 'fan', userName: 'fan', body: 'a' });
    const m2 = await real.addMessage({ channelId: id, userId: owner, userName: 'owner', body: 'b' });
    assert.equal(m1.subscriber, true);
    assert.equal(m2.owner, true);
    assert.deepEqual(
      (await real.listMessages(id, {})).map((m) => m.body),
      ['a', 'b']
    );
    assert.deepEqual(
      (await real.listMessages(id, { after: m1.messageId })).map((m) => m.body),
      ['b']
    );

    assert.equal(await real.setSubscription(id, 'fan', false), 0);
    assert.equal((await real.listMessages(id, {}))[0].subscriber, false);
    assert.equal(await real.deleteMessage(id, m1.messageId), true);
    assert.equal(await real.pruneMessages(7), 0);
  } finally {
    await real.db.query('DELETE FROM channels WHERE channel_id = $1', [id]);
    await real.db.pool.end();
  }
});
