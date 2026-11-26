/** Public application boundary. No Paws account credentials, callbacks, executable names or paths from visitors. */
import { createServer } from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, rm, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioStore, StudioError, uuid, normalizeVideo } from './store.mjs';
import { artifactName, validatePNG, writeZipArchive } from './artifacts.mjs';
import { createDispatcher } from './dispatcher.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const authorized = (actual, expected) => typeof actual === 'string' && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
async function body(req, limit) {
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > limit) throw new StudioError('body-too-large', 413); parts.push(part); }
  return Buffer.concat(parts);
}
async function jsonBody(req, limit = 8192) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new StudioError('json-required', 415);
  try { return JSON.parse(await body(req, limit)); } catch (e) { if (e instanceof StudioError) throw e; throw new StudioError('invalid-json'); }
}
const shape = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new StudioError('invalid-fields'); };
const phases = new Set(['source', 'transcript', 'proofread', 'plan', 'frames', 'selection', 'cards', 'archive', 'upload']);

export async function createStudio(options) {
  const { dataDir, workerToken, taskId } = options;
  if (typeof workerToken !== 'string' || workerToken.length < 32) throw new Error('Strong worker credential required');
  uuid(taskId);
  await mkdir(join(dataDir, 'assets'), { recursive: true, mode: 0o700 });
  const store = new StudioStore(join(dataDir, 'jobs.sqlite'), options);
  const clients = new Set(), budgets = new Map();
  let eventHeartbeat;
  const stopEventHeartbeat = () => {
    clearInterval(eventHeartbeat);
    eventHeartbeat = undefined;
  };
  const addEventClient = res => {
    clients.add(res);
    if (!eventHeartbeat) {
      // Transport only: a comment prevents a quiet proxy from closing SSE.
      // Do not read jobs or wake the dispatcher on a heartbeat.
      eventHeartbeat = setInterval(() => {
        for (const client of clients) {
          if (!client.writableEnded && !client.writableNeedDrain) client.write(': keepalive\n\n');
        }
      }, options.eventHeartbeatMs ?? 20_000);
      eventHeartbeat.unref();
    }
    res.once('close', () => {
      clients.delete(res);
      if (clients.size === 0) stopEventHeartbeat();
    });
  };
  const mutations = new Map();
  let downloads = 0, privateRequests = 0;
  const locked = async (id, action) => {
    const prior = mutations.get(id) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(action); mutations.set(id, current);
    try { return await current; } finally { if (mutations.get(id) === current) mutations.delete(id); }
  };
  const atomicWrite = async (target, bytes) => {
    const temp = `${target}.${randomUUID()}.tmp`, handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); await handle.close(); await rename(temp, target); }
    finally { await handle.close().catch(() => {}); await rm(temp, { force: true }); }
  };
  let origin = options.publicOrigin, dispatcher;
  const state = () => ({ connection: dispatcher?.connectionState() ?? 'disconnected', jobs: store.list().toReversed() });
  const changed = () => { const frame = `event: state\ndata: ${JSON.stringify(state())}\n\n`; for (const res of clients) { if (res.writableLength > 1_000_000) res.end(); else res.write(frame); } };
  dispatcher = (options.createDispatcher ?? createDispatcher)({ store, origin: options.pawsOrigin, taskId, token: options.webhookToken, changed });
  const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
  const artifactDir = id => join(dataDir, 'assets', uuid(id));
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    let downloadSlot = false, privateSlot = false;
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) throw new StudioError('origin-rejected', 403);
      const url = new URL(req.url, origin), path = url.pathname;
      if (url.search) throw new StudioError('query-not-supported');
      if (req.method === 'GET' && ['/', '/app.js', '/download.mjs', '/style.css'].includes(path)) {
        const name = path === '/' ? 'index.html' : path.slice(1), bytes = await readFile(join(publicDir, name));
        res.writeHead(200, { 'content-type': path === '/' ? 'text/html; charset=utf-8' : path === '/style.css' ? 'text/css' : 'application/javascript' }); res.end(bytes); return;
      }
      if (req.method === 'GET' && path === '/api/events') {
        if (clients.size >= 100) throw new StudioError('too-many-connections', 429);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
        addEventClient(res);
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`); return;
      }
      if (req.method === 'POST' && path === '/api/jobs') {
        const input = await jsonBody(req); shape(input, ['requestId', 'url']);
        uuid(input.requestId); normalizeVideo(input.url);
        // Idempotent retries do not consume a new capacity/rate slot.
        let existing; try { existing = store.get(input.requestId); } catch { /* New request. */ }
        if (!existing) {
          const ip = req.socket.remoteAddress, now = Date.now();
          let budget = budgets.get(ip);
          if (!budget || now - budget.at >= 60000) { if (budgets.size >= 1024) budgets.delete(budgets.keys().next().value); budget = { at: now, count: 0 }; budgets.set(ip, budget); }
          if (++budget.count > (options.perMinute ?? 3)) throw new StudioError('rate-limit', 429);
        }
        const job = store.submit(input.requestId, input.url); changed(); send(202, { job }); void dispatcher.wake(); return;
      }
      const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && jobMatch) { send(200, { job: store.get(jobMatch[1]) }); return; }
      const download = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(cards\.zip|card-\d{3}\.png)$/);
      if (req.method === 'GET' && download) {
        const job = store.get(download[1]); if (job.state !== 'completed' || !job.manifest) throw new StudioError('result-not-ready', 409);
        if (downloads >= (options.maxDownloads ?? 8)) throw new StudioError('download-limit', 429);
        downloads++; downloadSlot = true;
        if (download[2] !== 'cards.zip' && !job.manifest.cards.some(card => card.file === download[2])) throw new StudioError('artifact-not-found', 404);
        const target = join(artifactDir(job.id), download[2]);
        if (download[2] === 'cards.zip') await locked(job.id, async () => {
          try { await stat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; await writeZipArchive(artifactDir(job.id), job.manifest.cards); }
        });
        const info = await stat(target);
        res.writeHead(200, { 'content-type': download[2] === 'cards.zip' ? 'application/zip' : 'image/png', 'content-length': info.size,
          'content-disposition': `${download[2] === 'cards.zip' ? 'attachment' : 'inline'}; filename="${job.bvid}-${download[2]}"` });
        await pipeline(createReadStream(target), res); return;
      }
      if (path.startsWith('/internal/')) {
        if (!authorized(req.headers.authorization, `Bearer ${workerToken}`)) throw new StudioError('unauthorized', 401);
        if (privateRequests >= 8) throw new StudioError('upload-limit', 429);
        privateRequests++; privateSlot = true;
        if (path === '/internal/reconnect' && req.method === 'POST') { void dispatcher.reconnect(); send(202, { accepted: true }); return; }
        const internal = path.match(/^\/internal\/jobs\/([a-f0-9-]{36})\/(start|progress|complete|fail|artifacts\/card-\d{3}\.png)$/);
        if (!internal) throw new StudioError('not-found', 404);
        const [, id, action] = internal;
        await locked(id, async () => {
        if (action.startsWith('artifacts/') && req.method === 'PUT') {
          const job = store.assertRun(id, req.headers['x-run-id']);
          if (!['processing', 'completed', 'uncertain'].includes(job.state)) throw new StudioError('job-not-available', 409);
          const bytes = await body(req, 6 * 1024 * 1024); validatePNG(bytes);
          const name = artifactName(action.slice(10)), dir = artifactDir(id); await mkdir(dir, { recursive: true, mode: 0o700 });
          const target = join(dir, name); let prior; try { prior = await readFile(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (prior && sha256(prior) !== sha256(bytes)) throw new StudioError('artifact-conflict', 409);
          if (!prior) {
            if (job.state === 'completed') throw new StudioError('result-immutable', 409);
            // Recheck after awaits: an upstream terminal event can arrive while
            // a private upload is in progress, independently of this lock.
            store.transition(id, req.headers['x-run-id'], ['processing', 'uncertain'], {});
            let size = 0; for (const file of (await readdir(dir)).filter(name => /^card-\d{3}\.png$/.test(name))) size += (await stat(join(dir, file))).size;
            if (size + bytes.length > (options.maxArtifactBytes ?? 64 * 1024 * 1024)) throw new StudioError('artifacts-too-large', 413);
            await atomicWrite(target, bytes);
          }
          send(200, { sha256: sha256(bytes) }); return;
        }
        if (req.method !== 'POST') throw new StudioError('method-not-allowed', 405);
        const input = await jsonBody(req, 128 * 1024); uuid(input.runId);
        if (action === 'start') {
          shape(input, ['runId']); const job = store.bind(id, input.runId);
          if (job.state === 'uncertain') throw new StudioError('execution-uncertain', 409);
          send(200, { job: job.state === 'processing' ? job : store.transition(id, input.runId, ['waiting'], { state: 'processing', phase: 'source' }) }); changed(); return;
        }
        const job = store.assertRun(id, input.runId);
        if (action === 'complete' && job.state === 'completed') {
          if (JSON.stringify(job.manifest) !== JSON.stringify(input.manifest)) throw new StudioError('result-immutable', 409);
          send(200, { accepted: true }); return;
        }
        if (!['processing', 'uncertain'].includes(job.state)) throw new StudioError('job-not-available', 409);
        if (action === 'progress') {
          shape(input, ['runId', 'phase']); if (!phases.has(input.phase)) throw new StudioError('invalid-phase');
          store.transition(id, input.runId, ['processing', 'uncertain'], { phase: input.phase });
        } else if (action === 'fail') {
          shape(input, ['runId']); store.transition(id, input.runId, ['processing', 'uncertain'], { state: 'failed', error: 'creation-failed' });
        } else if (action === 'complete') {
          shape(input, ['runId', 'manifest']); const manifest = input.manifest;
          shape(manifest, ['title', 'author', 'source', 'cards']);
          if (manifest.source !== job.url || typeof manifest.title !== 'string' || manifest.title.length > 1000 || typeof manifest.author !== 'string' || manifest.author.length > 300
            || !Array.isArray(manifest.cards) || !manifest.cards.length || manifest.cards.length > 80) throw new StudioError('invalid-manifest');
          const unique = new Set();
          for (const card of manifest.cards) {
            shape(card, ['file', 'sha256', 'quote', 'start', 'end']); artifactName(card.file);
            if (unique.has(card.file) || typeof card.quote !== 'string' || !card.quote.trim() || card.quote.length > 20000 || !Number.isFinite(card.start) || !Number.isFinite(card.end)
              || card.start < 0 || card.end <= card.start || card.end > 3601) throw new StudioError('invalid-manifest');
            unique.add(card.file);
            const bytes = await readFile(join(artifactDir(id), card.file)); if (sha256(bytes) !== card.sha256) throw new StudioError('artifact-changed', 409);
          }
          await writeZipArchive(artifactDir(id), manifest.cards);
          store.transition(id, input.runId, ['processing', 'uncertain'], { state: 'completed', phase: 'complete', manifest, error: null });
        }
        changed(); send(200, { accepted: true }); return;
        }); return;
      }
      throw new StudioError('not-found', 404);
    } catch (error) { if (!res.headersSent) send(error instanceof StudioError ? error.status : 500, { error: error instanceof StudioError ? error.message : 'service-error' }); else res.end(); }
    finally { if (downloadSlot) downloads--; if (privateSlot) privateRequests--; }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  return { server, store, dispatcher,
    async listen(port = 0, host = '127.0.0.1') { await new Promise(ok => server.listen(port, host, ok)); origin ??= `http://127.0.0.1:${server.address().port}`; void dispatcher.connect(); return origin; },
    async close() { stopEventHeartbeat(); await dispatcher.stop(); for (const res of clients) res.end(); await new Promise(ok => server.close(ok)); store.close(); },
  };
}
