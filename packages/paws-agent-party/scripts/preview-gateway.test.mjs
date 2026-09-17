import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
const module = await import('./preview-gateway.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const origin = 'https://poc-unit-test.trycloudflare.com';
const password = 'preview-only-test-password-32bytes';
const backendToken = 'backend-only-test-password-32bytes';
async function fixture(t, extra = {}) {
  assert.equal(typeof module.createPreviewGateway, 'function', 'Protected preview gateway must exist');
  const hits = [];
  const upstream = createServer(async (req, res) => {
    const body = []; for await (const chunk of req) body.push(chunk);
    const item = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(body).toString() };
    hits.push(item); res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=secret', 'cache-control': 'public' }); res.end(JSON.stringify(item));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const backendUrl = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = await module.createPreviewGateway({ backendUrl, backendToken, password, lifetimeMs: 60000, ...extra });
  t.after(() => gateway.close());
  return { gateway, hits, backendUrl };
}
async function send(gateway, path = '/api/paws/status', { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(gateway.url + path, { method, headers: { host: new URL(origin).host, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  });
}
test('no traffic reaches the backend before the exact public origin is pinned', async t => {
  const { gateway, hits } = await fixture(t);
  assert.equal((await send(gateway)).status, 503); assert.equal(hits.length, 0);
  assert.throws(() => gateway.setPublicOrigin('https://example.com'));
  gateway.setPublicOrigin(origin); assert.throws(() => gateway.setPublicOrigin('https://other.trycloudflare.com'));
});
test('missing/wrong password cannot read APIs or start Agent work', async t => {
  const { gateway, hits } = await fixture(t); gateway.setPublicOrigin(origin);
  for (const method of ['GET', 'POST']) for (const auth of ['', 'Bearer wrong', 'Bearer ' + backendToken]) {
    assert.equal((await send(gateway, '/api/consultations', { method, headers: { origin, authorization: auth } })).status, 401);
  }
  assert.equal(hits.length, 0);
});
test('only exact HTTPS origin and Host are accepted, including authenticated mutations', async t => {
  const { gateway, hits } = await fixture(t); gateway.setPublicOrigin(origin);
  for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: origin + '/' }, { 'x-forwarded-proto': 'http' }]) {
    assert.equal((await send(gateway, '/api/consultations', { method: 'POST', headers: { authorization: 'Bearer ' + password, origin, ...headers } })).status, 403);
  }
  assert.equal((await send(gateway, '/api/consultations', { method: 'POST', headers: { authorization: 'Bearer ' + password } })).status, 403);
  assert.equal(hits.length, 0);
});
test('authorized API preserves body but rewrites only the fixed backend authority and token', async t => {
  const { gateway, hits, backendUrl } = await fixture(t); gateway.setPublicOrigin(origin);
  const body = JSON.stringify({ text: '真实会诊测试' });
  const result = await send(gateway, '/api/consultations', { method: 'POST', body, headers: { authorization: 'Bearer ' + password, origin, cookie: 'untrusted=1', 'x-forwarded-host': 'evil.example', 'content-type': 'application/json' } });
  assert.equal(result.status, 200); assert.equal(hits.length, 1);
  assert.equal(hits[0].headers.authorization, 'Bearer ' + backendToken);
  assert.equal(hits[0].headers.host, new URL(backendUrl).host); assert.equal(hits[0].headers.origin, backendUrl);
  assert.equal(hits[0].headers.cookie, undefined); assert.equal(hits[0].headers['x-forwarded-host'], undefined);
  assert.equal(hits[0].body, body); assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-frame-options'], 'DENY');
});
test('only public UI assets are available without a password', async t => {
  const { gateway, hits } = await fixture(t); gateway.setPublicOrigin(origin);
  assert.equal((await send(gateway, '/')).status, 200);
  assert.equal((await send(gateway, '/assets/index-abcd.js')).status, 200);
  assert.ok(hits.every(hit => hit.headers.authorization === undefined));
  for (const path of ['/access-token', '/.data/runs.json', '/src/server/auth.ts', '/api/assets/private', '/?token=bad']) {
    const result = await send(gateway, path); assert.ok([400, 401, 404].includes(result.status));
  }
  assert.equal(hits.length, 2);
});
test('non-origin targets and unsupported methods never forward', async t => {
  const { gateway, hits } = await fixture(t); gateway.setPublicOrigin(origin);
  for (const path of ['//evil.example/api/paws/status', '/%2e%2e/access-token', '/api/%5csecret']) {
    assert.ok([400, 404].includes((await send(gateway, path, { headers: { authorization: 'Bearer ' + password } })).status));
  }
  assert.equal((await send(gateway, '/', { method: 'TRACE' })).status, 405);
  assert.equal(hits.length, 0);
});
test('oversized requests are rejected before reaching upstream', async t => {
  const { gateway, hits } = await fixture(t); gateway.setPublicOrigin(origin);
  assert.equal((await send(gateway, '/api/assets', { method: 'POST', headers: { origin, authorization: 'Bearer ' + password, 'content-length': String(12 * 1024 * 1024) } })).status, 413);
  assert.equal(hits.length, 0);
});
test('expiration closes access and calls the lifecycle hook once', async t => {
  let expired = 0; const { gateway } = await fixture(t, { lifetimeMs: 80, onExpire: () => expired++ }); gateway.setPublicOrigin(origin);
  await new Promise(resolve => setTimeout(resolve, 130));
  await assert.rejects(() => send(gateway)); assert.equal(expired, 1); await gateway.close(); assert.equal(expired, 1);
});
test('non-loopback backends and excessive lifetimes are rejected', async () => {
  assert.equal(typeof module.createPreviewGateway, 'function');
  for (const extra of [{ backendUrl: 'http://example.com' }, { backendUrl: 'http://127.0.0.1:1234/path' }, { lifetimeMs: 86400001 }, { password: 'short' }]) {
    await assert.rejects(() => module.createPreviewGateway({ backendUrl: 'http://127.0.0.1:1234', backendToken, password, ...extra }));
  }
});
test('a synchronous expiry callback error cannot crash the preview process', async t => {
  const { gateway } = await fixture(t, { lifetimeMs: 50, onExpire: () => { throw Error('simulated cleanup failure'); } });
  gateway.setPublicOrigin(origin);
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(() => send(gateway));
});
