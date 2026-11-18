import test from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/app.js');
const server = createApp({ rateLimit: { max: 3, windowSeconds: 60 } }).listen(0);
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

test('config reports dev mode without Cognito', async () => {
  const { status, body } = await call('GET', '/api/auth/config');
  assert.equal(status, 200);
  assert.equal(body.data.mode, 'dev');
});

test('dev login, me and upgrade', async () => {
  const login = await call('POST', '/api/auth/dev-login', { body: { email: 'a@example.com' } });
  assert.equal(login.status, 200);
  const me = await call('GET', '/api/auth/me', { token: login.body.data.token });
  assert.equal(me.body.data.tier, 'free');
  const up = await call('POST', '/api/auth/upgrade', { token: login.body.data.token });
  assert.equal(up.body.data.tier, 'premium');
  const me2 = await call('GET', '/api/auth/me', { token: up.body.data.token });
  assert.equal(me2.body.data.tier, 'premium');
});

test('me requires a valid token', async () => {
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
});

test('dev login validates input and is rate limited', async () => {
  assert.equal((await call('POST', '/api/auth/dev-login', { body: { email: 'nope' } })).status, 400);
  // 3 request trong cửa sổ (2 ở trên + 1 này) đã chạm giới hạn, request tiếp theo bị chặn
  assert.equal((await call('POST', '/api/auth/dev-login', { body: { email: 'b@example.com' } })).status, 429);
});
