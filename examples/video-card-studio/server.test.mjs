import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createStudio, sha256 } from './server.mjs';
import { crc32, validatePNG } from './artifacts.mjs';
import { createDispatcher } from './dispatcher.mjs';
import { StudioStore } from './store.mjs';

function png(pixels = Buffer.from([0, 255, 0, 0, 0, 255, 0])) {
  const chunk = (type, bytes) => { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length); const value = Buffer.concat([Buffer.from(type), bytes]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(value)); return Buffer.concat([prefix, value, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
test('real HTTP application enforces input, private result binding, immutable PNGs, SSE and downloadable ZIP', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'card-http-')), workerToken = randomBytes(32).toString('hex'), taskId = randomUUID();
  const studio = await createStudio({ dataDir, workerToken, taskId, perMinute: 20, createDispatcher: () => ({ connect() {}, wake() {}, stop() {}, connectionState: () => 'connected' }) });
  const origin = await studio.listen(), eventAbort = new AbortController();
  const request = async (path, data, { token = workerToken, method = 'POST', headers = {} } = {}) => fetch(origin + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(data === undefined ? {} : { body: Buffer.isBuffer(data) ? data : JSON.stringify(data) }) });
  try {
    assert.equal((await request('/api/jobs', { requestId: randomUUID(), url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await request('/api/jobs', { requestId: randomUUID(), url: 'BV1xx411c7mD', command: 'sh' })).status, 400);
    assert.equal((await request('/api/jobs', { requestId: randomUUID(), url: 'BV1xx411c7mD' }, { headers: { origin: 'https://evil.example' } })).status, 403);
    const id = randomUUID(), second = randomUUID(), runId = randomUUID();
    assert.equal((await request('/api/jobs', { requestId: id, url: 'BV1xx411c7mD' })).status, 202);
    assert.equal((await request('/api/jobs', { requestId: id, url: 'BV1xx411c7mD' })).status, 202);
    assert.equal((await request('/api/jobs', { requestId: second, url: 'BV1Q541167Qg' })).status, 202);
    assert.equal(studio.store.list().length, 2);
    const events = await fetch(origin + '/api/events', { signal: eventAbort.signal }), reader = events.body.getReader();
    assert.match(Buffer.from((await reader.read()).value).toString(), /event: state/);
    studio.store.update(id, { state: 'dispatching' });
    assert.equal((await request(`/internal/jobs/${id}/start`, { runId }, { token: null })).status, 401);
    assert.equal((await request(`/internal/jobs/${id}/start`, { runId })).status, 200);
    assert.equal((await request(`/internal/jobs/${id}/progress`, { runId: randomUUID(), phase: 'cards' })).status, 409);
    const image = png(); assert.deepEqual(validatePNG(image), { width: 2, height: 1 });
    assert.equal((await request(`/internal/jobs/${id}/artifacts/card-001.png`, Buffer.from('not PNG'), { method: 'PUT', headers: { 'x-run-id': runId } })).status, 400);
    assert.equal((await request(`/internal/jobs/${id}/artifacts/card-001.png`, image, { method: 'PUT', headers: { 'x-run-id': runId } })).status, 200);
    const manifest = { title: '<script>untrusted</script>', author: '测试作者', source: 'https://www.bilibili.com/video/BV1xx411c7mD/', cards: [{ file: 'card-001.png', sha256: sha256(image), quote: '原话，保留条件和否定。', start: 1, end: 2 }] };
    assert.equal((await request(`/internal/jobs/${second}/complete`, { runId, manifest })).status, 409);
    assert.equal((await request(`/internal/jobs/${id}/complete`, { runId, manifest })).status, 200);
    assert.equal((await request(`/internal/jobs/${id}/complete`, { runId, manifest })).status, 200);
    assert.equal((await request(`/internal/jobs/${id}/complete`, { runId, manifest: { ...manifest, title: 'mutated' } })).status, 409);
    const single = await fetch(`${origin}/api/jobs/${id}/card-001.png`); assert.equal(single.status, 200); assert.equal(sha256(Buffer.from(await single.arrayBuffer())), sha256(image));
    const zip = await fetch(`${origin}/api/jobs/${id}/cards.zip`), archive = join(dataDir, 'download.zip');
    assert.equal(zip.status, 200); await writeFile(archive, Buffer.from(await zip.arrayBuffer()));
    assert.match(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }), /No errors detected/);
    assert.equal(studio.store.next().id, second);
    const html = await (await fetch(origin)).text(); assert(!html.includes(workerToken));
  } finally { eventAbort.abort(); await studio.close(); }
});

test('quiet SSE connections receive transport comments without rereading jobs or waking the dispatcher', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'card-stream-'));
  let listReads = 0;
  const studio = await createStudio({ dataDir, workerToken: randomBytes(32).toString('hex'), taskId: randomUUID(), eventHeartbeatMs: 20,
    createDispatcher: () => ({ connect() {}, wake() { assert.fail('heartbeat must not wake dispatcher'); }, stop() {}, connectionState: () => 'connected' }) });
  const list = studio.store.list.bind(studio.store);
  studio.store.list = () => { listReads++; return list(); };
  const origin = await studio.listen(), controller = new AbortController();
  try {
    const response = await fetch(origin + '/api/events', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    let frames = '';
    for await (const part of response.body) {
      frames += Buffer.from(part).toString();
      if (frames.includes(': keepalive\n\n')) break;
    }
    assert.match(frames, /^event: state\n/);
    assert.match(frames, /\n\n: keepalive\n\n/);
    assert.equal(listReads, 1);
  } finally {
    controller.abort();
    await studio.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('dispatcher uses task events to drain two inputs, survives lost acceptance response, and never retries uncertainty', async () => {
  const store = new StudioStore(':memory:'); const first = randomUUID(), second = randomUUID();
  store.submit(first, 'BV1xx411c7mD'); store.submit(second, 'BV1Q541167Qg');
  let controller, lost = true, active = null, calls = [], runs = [];
  const stream = signal => new Response(new ReadableStream({ start(c) { controller = c; signal.addEventListener('abort', () => c.close(), { once: true }); c.enqueue(Buffer.from(`data: ${JSON.stringify({ activeRunId: active, runs })}\n\n`)); } }), { headers: { 'content-type': 'text/event-stream' } });
  const event = value => controller.enqueue(Buffer.from(`data: ${JSON.stringify(value)}\n\n`));
  let notify; const nextChange = () => new Promise(resolve => { notify = resolve; });
  const dispatcher = createDispatcher({ store, origin: 'https://paws.invalid', taskId: randomUUID(), token: 'private', changed: () => notify?.(), openEvents: async (_url, init) => stream(init.signal), fetchImpl: async (_url, init) => {
    const input = JSON.parse(init.body); calls.push(input.requestId);
    if (lost) { lost = false; throw new Error('acceptance response lost'); }
    const run = { runId: randomUUID(), requestId: input.requestId, status: 'pending' }; runs.push(run); active = run.runId;
    return Response.json(run, { status: 202 });
  } });
  const until = async predicate => { if (predicate()) return; await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('event deadline')), 2000); notify = () => { if (predicate()) { clearTimeout(timer); resolve(); } }; }); };
  try {
    void dispatcher.connect(); await until(() => calls.length === 1 && dispatcher.connectionState() === 'disconnected');
    assert.equal(store.get(first).state, 'dispatching');
    await dispatcher.reconnect(); await until(() => store.get(first).state === 'waiting');
    assert.deepEqual(calls, [first, first]);
    store.update(first, { state: 'completed', manifest: { cards: [] } }); active = null; runs[0].status = 'completed';
    event({ activeRunId: null, runs }); await until(() => store.get(second).state === 'waiting');
    assert.deepEqual(calls, [first, first, second]);
    runs[1].status = 'uncertain'; event({ activeRunId: runs[1].runId, runs }); await until(() => store.get(second).state === 'uncertain');
    await dispatcher.wake(); assert.equal(calls.length, 3);
  } finally { await dispatcher.stop(); store.close(); }
});

test('PNG validation rejects truncated scanlines and unsupported filters with otherwise valid CRC and zlib', () => {
  assert.throws(() => validatePNG(png(Buffer.from([0, 1]))), /invalid-png/);
  assert.throws(() => validatePNG(png(Buffer.from([5, 255, 0, 0, 0, 255, 0]))), /invalid-png/);
});

test('concurrent result commits stay immutable and concurrent uploads cannot exceed the per-job budget', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'card-races-')), workerToken = randomBytes(32).toString('hex'), image = png();
  const studio = await createStudio({ dataDir, workerToken, taskId: randomUUID(), maxArtifactBytes: image.length + 1,
    createDispatcher: () => ({ connect() {}, wake() {}, stop() {}, connectionState: () => 'connected' }) });
  const origin = await studio.listen();
  const request = (id, action, runId, value) => fetch(`${origin}/internal/jobs/${id}/${action}`, { method: Buffer.isBuffer(value) ? 'PUT' : 'POST', headers: {
    authorization: `Bearer ${workerToken}`, 'content-type': 'application/json', 'x-run-id': runId }, body: Buffer.isBuffer(value) ? value : JSON.stringify({ runId, ...value }) });
  try {
    for (const race of ['fail', 'complete']) {
      const id = randomUUID(), runId = randomUUID(); studio.store.submit(id, 'BV1xx411c7mD'); studio.store.update(id, { state: 'dispatching' });
      await request(id, 'start', runId, {});
      const uploads = await Promise.all(['card-001.png', 'card-002.png'].map(name => request(id, 'artifacts/' + name, runId, image)));
      assert.deepEqual(uploads.map(r => r.status).sort(), [200, 413]);
      const file = uploads[0].status === 200 ? 'card-001.png' : 'card-002.png';
      const manifest = { title: '原话', author: '作者', source: studio.store.get(id).url, cards: [{ file, sha256: sha256(image), quote: '完整原话', start: 1, end: 2 }] };
      const completed = request(id, 'complete', runId, { manifest });
      const other = request(id, race, runId, race === 'complete' ? { manifest: { ...manifest, title: '不同版本' } } : {});
      const responses = await Promise.all([completed, other]);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
      assert.equal((await request(id, 'progress', runId, { phase: 'cards' })).status, 409);
      assert(!(await readdir(join(dataDir, 'assets', id))).some(name => name.endsWith('.tmp')));
      if (studio.store.get(id).state === 'completed') {
        const zip = join(dataDir, 'assets', id, 'cards.zip'), before = (await stat(zip)).mtimeMs;
        await (await fetch(`${origin}/api/jobs/${id}/cards.zip`)).arrayBuffer(); await (await fetch(`${origin}/api/jobs/${id}/cards.zip`)).arrayBuffer();
        assert.equal((await stat(zip)).mtimeMs, before);
      }
    }
  } finally { await studio.close(); }
});

test('slow anonymous downloads are bounded by a stream concurrency limit', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'card-download-'));
  const studio = await createStudio({ dataDir, workerToken: randomBytes(32).toString('hex'), taskId: randomUUID(), maxDownloads: 1,
    createDispatcher: () => ({ connect() {}, wake() {}, stop() {}, connectionState: () => 'connected' }) });
  const origin = await studio.listen(), id = randomUUID(); let slow;
  try {
    studio.store.submit(id, 'BV1xx411c7mD'); studio.store.update(id, { state: 'completed', manifest: { cards: [] } });
    await mkdir(join(dataDir, 'assets', id)); await writeFile(join(dataDir, 'assets', id, 'cards.zip'), randomBytes(16 * 1024 * 1024));
    await new Promise((resolve, reject) => { slow = get(`${origin}/api/jobs/${id}/cards.zip`, res => { res.pause(); resolve(); }); slow.on('error', reject); });
    assert.equal((await fetch(`${origin}/api/jobs/${id}/cards.zip`)).status, 429);
  } finally { slow?.destroy(); await studio.close(); }
});
