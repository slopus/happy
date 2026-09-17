import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TestOnlySdk } from './fake-sdk.js';
import { decryptText } from '../vendor/agents-party/src/core/crypto.js';
import type { PocServer } from '../src/server/http.js';
const builtUrl = new URL('../dist/server.mjs', import.meta.url).href;
const { createPocServer } = await import(builtUrl);
const dataDir = await mkdtemp(join(tmpdir(), 'paws-party-built-smoke-'));
const token = randomUUID();
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
let server: PocServer | undefined;
try {
  server = await createPocServer({ dataDir, accessToken: token });
  assert(server);
  const html = await fetch(server.url).then(response => { assert.equal(response.status, 200); return response.text(); });
  assert(html.includes('lang="zh-CN"'));
  assert(!html.includes(token));
  const assetPath = html.match(/src="([^"]+\.js)"/)?.[1]; assert(assetPath);
  const js = await fetch(server.url + assetPath).then(response => { assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /javascript/); return response.text(); });
  assert(js.length > 0);
  assert(!js.includes('TestOnlySdk'));
  assert.equal((await fetch(server.url + '/api/paws/status')).status, 401);
  assert.equal((await fetch(server.url + '/api/paws/status', { headers }).then(response => response.json())).state, 'disconnected');
  console.log('PASS built normal HTTP: HTML/assets 200, API 401 without token, real SDK disconnected, no fixture in bundle.');
  await server.close(); server = undefined;
  const sdk = new TestOnlySdk();
  server = await createPocServer({ dataDir, accessToken: token, sdk }); assert(server);
  const body = { requestId: randomUUID(), stock: 'TEST', text: 'fixture smoke', images: [], machineId: 'machine-1', directory: '/tmp', mode: 'consultation', agents: { moderator: 'codex', trend30: 'codex', structure10: 'codex', timing1: 'codex' } };
  const started = await fetch(server.url + '/api/consultations', { method: 'POST', headers, body: JSON.stringify(body) }).then(response => response.json());
  let run = started;
  for (let i = 0; i < 200 && run.status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    run = await fetch(server.url + '/api/consultations/' + started.id, { headers }).then(response => response.json());
  }
  assert.equal(run.status, 'completed'); assert.equal(run.turns.length, 8);
  const party = await fetch(server.url + '/api/parties/' + run.partyId, { headers }).then(response => response.json());
  const page = await fetch(server.url + '/api/parties/' + run.partyId + '/messages?limit=100', { headers }).then(response => response.json());
  assert.equal(page.messages.filter((message: { from: string; kind: string }) => message.from !== 'host' && message.kind === 'message').length, 8);
  const last = page.messages.at(-1); assert((await decryptText(party.key, last.text))?.includes('public-moderator-2'));
  const persisted = JSON.parse(await readFile(join(dataDir, 'runs.json'), 'utf8')); assert.equal(persisted.runs[0].snapshot.turns.length, 8);
  console.log('PASS built fixture HTTP: real Party SQLite/encrypted history, 8 public turns, 8 persisted exact turn associations. Not live-model acceptance.');
} finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
