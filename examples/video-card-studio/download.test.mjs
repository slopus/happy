import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readArchiveBlob, readPngBlob } from './public/download.mjs';
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

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
const pngHeaders = { 'content-type': 'image/png' };

test('PNG reader preserves the bytes and filename-ready MIME of a complete streamed response', async () => {
  for (const declared of [null, png.length]) {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(png.slice(0, 3)); c.enqueue(png.slice(3)); c.close(); } }),
      { headers: { ...pngHeaders, ...(declared === null ? {} : { 'content-length': String(declared) }) } });
    const blob = await readPngBlob('/card.png', { fetchImpl: async () => response });
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), png);
  }
});

test('PNG reader rejects invalid MIME, a corrupt signature, truncated bodies and partial HTTP responses', async () => {
  const corrupt = png.slice();
  corrupt[7] ^= 1;
  for (const response of [
    new Response(png, { headers: { 'content-type': 'image/jpeg' } }),
    new Response(corrupt, { headers: pngHeaders }),
    new Response(png, { headers: { ...pngHeaders, 'content-length': '11' } }),
    new Response(png.slice(0, 7), { headers: pngHeaders }),
    new Response(png, { status: 206, headers: pngHeaders }),
  ]) {
    await assert.rejects(readPngBlob('/card.png', { fetchImpl: async () => response }));
  }
});

test('PNG reader enforces its six MiB limit without a declared length', async () => {
  let cancelled = false;
  const pixels = new Uint8Array(6 * 1024 * 1024 + 1);
  pixels.set(png);
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(pixels); }, cancel() { cancelled = true; } }), { headers: pngHeaders });
  await assert.rejects(readPngBlob('/card.png', { fetchImpl: async () => response }));
  assert.equal(cancelled, true);
});
