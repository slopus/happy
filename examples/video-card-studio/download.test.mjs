import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readArchiveBlob } from './public/download.mjs';
const bytes = Uint8Array.from([80, 75, 3, 4, 5, 6, 7, 8]);
const headers = { 'content-type': 'application/zip' };

test('archive reader preserves every streamed byte, with or without Content-Length', async () => {
  for (const declared of [null, bytes.length]) {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 2)); c.enqueue(bytes.slice(2)); c.close(); } }),
      { headers: { ...headers, ...(declared ? { 'content-length': String(declared) } : {}) } });
    const blob = await readArchiveBlob('/archive', { fetchImpl: async () => response });
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes); assert.equal(blob.type, 'application/zip');
  }
});

test('archive reader rejects errors, HTML, malformed ZIP and truncated successful responses', async () => {
  for (const response of [new Response('busy', { status: 429 }), new Response('<html>error</html>'),
    new Response('not a zip', { headers }), new Response(bytes, { headers: { ...headers, 'content-length': '20' } })]) {
    await assert.rejects(readArchiveBlob('/archive', { fetchImpl: async () => response }));
  }
});

test('archive reader stops an oversized stream even when its declared size is absent or false', async () => {
  for (const declared of [null, 1, 100]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel() { cancelled = true; } }),
      { headers: { ...headers, ...(declared ? { 'content-length': String(declared) } : {}) } });
    await assert.rejects(readArchiveBlob('/archive', { maxBytes: 4, fetchImpl: async () => response }));
    assert.equal(cancelled, true);
  }
});
