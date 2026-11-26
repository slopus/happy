/** Single-process durable FIFO. Job IDs are also upstream idempotency keys. */
import { DatabaseSync } from 'node:sqlite';

export class StudioError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
export const uuid = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new StudioError('invalid-id');
  return value.toLowerCase();
};
export function normalizeVideo(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new StudioError('invalid-video');
  value = value.trim();
  let bvid = value;
  if (!/^BV[0-9A-Za-z]{10}$/.test(value)) {
    let url; try { url = new URL(value); } catch { throw new StudioError('invalid-video'); }
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    if (!['https:', 'http:'].includes(url.protocol) || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)
      || url.port || url.username || url.password || !match || (url.searchParams.has('p') && url.searchParams.get('p') !== '1')) throw new StudioError('invalid-video');
    bvid = match[1];
  }
  return { bvid, url: `https://www.bilibili.com/video/${bvid}/` };
}
export class StudioStore {
  constructor(file, { capacity = 100, queueCapacity = 20 } = {}) {
    this.db = new DatabaseSync(file); this.capacity = capacity; this.queueCapacity = queueCapacity;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  get(id) { const row = this.db.prepare('SELECT value FROM jobs WHERE id=?').get(uuid(id)); if (!row) throw new StudioError('job-not-found', 404); return JSON.parse(row.value); }
  list() { return this.db.prepare('SELECT value FROM jobs ORDER BY ordinal ASC').all().map(row => JSON.parse(row.value)); }
  submit(requestId, input) {
    const id = uuid(requestId), { bvid, url } = normalizeVideo(input);
    const row = this.db.prepare('SELECT value FROM jobs WHERE id=?').get(id);
    if (row) { const prior = JSON.parse(row.value); if (prior.bvid !== bvid) throw new StudioError('idempotency-conflict', 409); return prior; }
    const all = this.list();
    if (all.length >= this.capacity || all.filter(job => !['completed', 'failed'].includes(job.state)).length >= this.queueCapacity) throw new StudioError('queue-full', 429);
    const job = { id, bvid, url, state: 'queued', phase: 'queued', runId: null, createdAt: Date.now(), updatedAt: Date.now(), manifest: null, error: null };
    this.db.prepare('INSERT INTO jobs(id,value) VALUES (?,?)').run(id, JSON.stringify(job));
    return job;
  }
  update(id, patch) {
    const job = this.get(id);
    const next = { ...job, ...patch, id: job.id, bvid: job.bvid, url: job.url, updatedAt: Date.now() };
    this.db.prepare('UPDATE jobs SET value=? WHERE id=?').run(JSON.stringify(next), job.id); return next;
  }
  transition(id, runId, states, patch) {
    const job = this.assertRun(id, runId);
    if (!states.includes(job.state)) throw new StudioError('job-not-available', 409);
    return this.update(id, patch);
  }
  next() {
    const jobs = this.list();
    const active = jobs.find(job => ['dispatching', 'waiting', 'processing', 'uncertain'].includes(job.state));
    return active ? null : jobs.find(job => job.state === 'queued') ?? null;
  }
  outstanding() { return this.list().find(job => ['dispatching', 'waiting', 'processing', 'uncertain'].includes(job.state)) ?? null; }
  bind(id, runId) {
    const job = this.get(id); uuid(runId);
    if (job.runId && job.runId !== runId) throw new StudioError('run-mismatch', 409);
    if (!['dispatching', 'waiting', 'processing', 'uncertain'].includes(job.state)) throw new StudioError('job-not-available', 409);
    return this.update(id, { runId, ...(job.state === 'dispatching' ? { state: 'waiting' } : {}) });
  }
  assertRun(id, runId) {
    const job = this.get(id);
    if (job.runId !== uuid(runId)) throw new StudioError('run-mismatch', 409);
    return job;
  }
}
