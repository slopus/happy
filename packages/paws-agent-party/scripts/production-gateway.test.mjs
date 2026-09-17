import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createProductionGateway } from './production-gateway.mjs';

test('production prefix preserves API authentication and validates browser authority', async t => {
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push({ path: req.url, host: req.headers.host, authorization: req.headers.authorization });
    res.writeHead(req.headers.authorization === 'Bearer test-only' ? 200 : 401);
    res.end('{}');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const gateway = await createProductionGateway({ backendUrl: `http://127.0.0.1:${backend.address().port}`, port: 0, revision: 'a'.repeat(40) });
  t.after(() => gateway.close());
  const call = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request(gateway.url, { path, method, headers: { host: '47.115.228.20:8443', ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(await call('/agent-party/api/paws/status'), 401);
  assert.equal(await call('/agent-party/api/paws/status', { authorization: 'Bearer test-only' }), 200);
  assert.equal(seen.at(-1).path, '/api/paws/status');
  assert.equal(seen.at(-1).authorization, 'Bearer test-only');
  assert.equal(await call('/api/paws/status'), 404);
  assert.equal(await call('/agent-party/api/paws/status', { host: 'evil.invalid' }), 403);
  assert.equal(await call('/agent-party/api/paws/recover', { origin: 'https://evil.invalid' }, 'POST'), 403);
  assert.equal(await call('/agent-party/api/paws/recover', {}, 'POST'), 403);
  assert.equal(await call('/agent-party/api/paws/recover', { origin: 'https://47.115.228.20:8443', authorization: 'Bearer test-only' }, 'POST'), 200);
  assert.equal(await call('/agent-party/../api/paws/status'), 400);
  assert.equal(await call('/agent-party/%2e%2e/api/paws/status'), 400);
  assert.equal(await call('/agent-party/api/paws/status?token=oops'), 400);
  assert.equal(await call('/agent-party/revision'), 200);
  assert.equal(await call('/agent-party/revision', { host: 'evil.invalid' }), 403);
});
