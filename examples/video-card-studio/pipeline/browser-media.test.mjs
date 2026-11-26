import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedFile } from './browser-media.mjs';

test('media size is enforced during transfer, partial files cannot become completed media', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bounded-media-'));
  try {
    let reads = 0;
    await assert.rejects(boundedFile(async () => ({ done: false, value: Buffer.alloc(8, ++reads) }), join(dir, 'video.m4s'), 12), /上限/);
    assert.equal(reads, 2); assert.deepEqual(await readdir(dir), []);
    reads = 0;
    const size = await boundedFile(async () => ++reads === 1 ? { done: false, value: Buffer.from('complete') } : { done: true }, join(dir, 'video.m4s'), 12);
    assert.equal(size, 8); assert.equal(await readFile(join(dir, 'video.m4s'), 'utf8'), 'complete');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
