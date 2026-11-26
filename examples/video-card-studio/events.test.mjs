import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openEventStream } from './events.mjs';
import { consumeEvents } from './dispatcher.mjs';

async function fixture(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test('SSE retains a quiet connection beyond its header deadline and delivers the next event once', async () => {
  let requests = 0;
  const source = await fixture((_req, res) => {
    requests++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"step":1}\n\n');
    const nextEvent = setTimeout(() => res.end('data: {"step":2}\n\n'), 120);
    res.once('close', () => clearTimeout(nextEvent));
  });
  try {
    const events = [];
    await consumeEvents(await openEventStream(source.origin, { headerTimeoutMs: 40 }), value => events.push(value));
    assert.deepEqual(events, [{ step: 1 }, { step: 2 }]); assert.equal(requests, 1);
  } finally { await source.close(); }
});

test('SSE bounds a missing handshake and aborts an established stream without reconnecting', async () => {
  let requests = 0, closed;
  const source = await fixture((req, res) => {
    requests++;
    if (req.url === '/silent') return;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n');
    res.once('close', () => closed?.());
  });
  try {
    await assert.rejects(openEventStream(source.origin + '/silent', { headerTimeoutMs: 40 }), /event-connection-timeout/);
    const controller = new AbortController(), response = await openEventStream(source.origin, { signal: controller.signal });
    const serverClosed = new Promise(resolve => { closed = resolve; });
    const consuming = consumeEvents(response, () => controller.abort());
    await assert.rejects(consuming); await serverClosed; assert.equal(requests, 2);
  } finally { await source.close(); }
});

test('SSE refuses redirects and non-event responses without forwarding its credential', async () => {
  let requests = 0;
  const source = await fixture((req, res) => {
    requests++;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/elsewhere' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('not events'); }
  });
  try {
    await assert.rejects(openEventStream(source.origin + '/redirect', { headers: { authorization: 'Bearer test-only' } }), /event-connection-failed/);
    await assert.rejects(openEventStream(source.origin), /event-connection-failed/);
    assert.equal(requests, 2);
  } finally { await source.close(); }
});
