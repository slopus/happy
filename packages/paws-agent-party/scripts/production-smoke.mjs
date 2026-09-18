import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createAccountServer, AccountAccess } from '../dist/server.mjs';
import { createProductionGateway } from './production-gateway.mjs';

const dataDir = await mkdtemp(join(tmpdir(), 'paws-party-production-smoke-'));
const accessToken = randomBytes(32).toString('base64url');
let backend, gateway;
try {
  const access = new AccountAccess('http://fixture.invalid', accessToken, async () => Response.json({ id: 'smoke-owner' }));
  backend = await createAccountServer({ dataDir, masterKey: accessToken, serverUrl: 'http://fixture.invalid', access, staticDir: new URL('../dist/web/', import.meta.url).pathname });
  const frameToken = access.exchange(access.issue({ id: 'smoke-owner', name: 'Smoke test' }, 'fixture-only')).token;
  gateway = await createProductionGateway({ backendUrl: backend.url, port: 0, revision: 'a'.repeat(40) });
  const get = (path, authenticated = false) => new Promise((resolve, reject) => {
    request(gateway.url, { path, headers: { host: '47.115.228.20:8443', ...(authenticated ? { authorization: `Bearer ${frameToken}` } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
  const index = await get('/agent-party/'); assert.equal(index.status, 200);
  const scripts = [...index.body.matchAll(/src="(\/agent-party\/assets\/[^"<>]+\.js)"/g)];
  assert.ok(scripts.length, 'Build must use /agent-party/ base path');
  for (const match of scripts) assert.equal((await get(match[1])).status, 200);
  assert.equal((await get('/agent-party/api/paws/status')).status, 401);
  assert.equal(JSON.parse((await get('/agent-party/api/access/config')).body).accountMode, true);
  assert.equal(JSON.parse((await get('/agent-party/api/paws/status', true)).body).state, 'disconnected');
  assert.equal((await get('/agent-party/revision')).body.trim(), 'a'.repeat(40));
  console.log('Standalone production smoke passed: prefix assets, account authentication, isolated API, revision.');
} finally {
  await gateway?.close(); await backend?.close();
  await rm(dataDir, { recursive: true, force: true });
}
