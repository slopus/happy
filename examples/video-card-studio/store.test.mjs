import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StudioStore, normalizeVideo } from './store.mjs';

test('accepts only canonical public single-part Bilibili identifiers', () => {
  assert.equal(normalizeVideo('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=123').bvid, 'BV1xx411c7mD');
  for (const input of ['http://127.0.0.1/private', 'https://bilibili.com.evil/video/BV1xx411c7mD', 'file:///etc/passwd', 'https://www.bilibili.com/video/BV1xx411c7mD?p=2', '$(touch pwned)', 'https://user:secret@www.bilibili.com/video/BV1xx411c7mD']) assert.throws(() => normalizeVideo(input));
});
test('SQLite queue retains two distinct inputs, idempotency and assignment over restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'studio-')), 'jobs.sqlite');
  let store = new StudioStore(file);
  const first = randomUUID(), second = randomUUID(), run = randomUUID();
  store.submit(first, 'BV1xx411c7mD'); store.submit(second, 'BV1Q541167Qg');
  assert.equal(store.submit(first, 'BV1xx411c7mD').id, first);
  assert.throws(() => store.submit(first, 'BV1Q541167Qg'), /idempotency-conflict/);
  assert.equal(store.next().id, first);
  store.update(first, { state: 'dispatching' }); store.bind(first, run);
  store.close(); store = new StudioStore(file);
  assert.equal(store.get(first).runId, run);
  assert.equal(store.list().length, 2);
  assert.equal(store.next(), null);
  store.update(first, { state: 'completed' });
  assert.equal(store.next().id, second);
  store.close();
});
test('unknown work blocks automatic replay and result writes cannot cross runs', () => {
  const store = new StudioStore(':memory:'); const job = randomUUID(), run = randomUUID();
  store.submit(job, 'BV1xx411c7mD'); store.update(job, { state: 'dispatching' }); store.bind(job, run);
  assert.throws(() => store.assertRun(job, randomUUID()), /run-mismatch/);
  store.update(job, { state: 'uncertain' });
  assert.equal(store.next(), null);
  assert.throws(() => store.bind(job, randomUUID()), /run-mismatch/);
  store.close();
});
