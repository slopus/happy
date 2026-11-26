import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDispatcher } from './dispatcher.mjs';
import { StudioStore } from './store.mjs';

for (const scenario of ['accepted-response-lost', 'not-accepted-response-lost', 'html-response', 'missing-run-id', 'truncated-json']) {
  test(`dispatch recovery: ${scenario} preserves the request identity and replaces a silent stream`, async () => {
    const store = new StudioStore(':memory:'), id = randomUUID(), runId = randomUUID(); store.submit(id, 'BV1xx411c7mD');
    let calls = [], streams = 0, aborts = 0, runs = [], changed;
    const until = predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('event deadline')), 3000);
      changed = () => { if (predicate()) { clearTimeout(timer); resolve(); } }; changed();
    });
    const dispatcher = createDispatcher({ store, origin: 'http://test.invalid', taskId: randomUUID(), token: 'not-a-secret', changed: () => changed?.(),
      openEvents: async (_url, options) => {
          streams++;
          return new Response(new ReadableStream({ start(controller) {
            options.signal.addEventListener('abort', () => { aborts++; controller.close(); }, { once: true });
            controller.enqueue(Buffer.from(`data: ${JSON.stringify({ activeRunId: runs.length ? runId : null, runs })}\n\n`));
          } }), { headers: { 'content-type': 'text/event-stream' } });
      },
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body); calls.push(request.requestId);
        if (calls.length === 1) {
          if (scenario === 'accepted-response-lost') runs = [{ requestId: id, runId, status: 'pending' }];
          if (scenario.endsWith('response-lost')) throw new Error('connection lost');
          if (scenario === 'html-response') return new Response('<html>proxy error</html>', { status: 502 });
          if (scenario === 'truncated-json') return new Response('{"runId":', { status: 202 });
          return Response.json({ requestId: id }, { status: 202 });
        }
        runs = [{ requestId: id, runId, status: 'pending' }]; return Response.json(runs[0], { status: 202 });
      } });
    try {
      void dispatcher.connect();
      await until(() => calls.length === 1 && dispatcher.connectionState() === 'disconnected');
      assert.equal(store.get(id).state, 'dispatching');
      await dispatcher.reconnect(); await until(() => store.get(id).state === 'waiting');
      assert.equal(store.get(id).runId, runId); assert.equal(streams, 2); assert.equal(aborts, 1);
      assert.deepEqual(calls, scenario === 'accepted-response-lost' ? [id] : [id, id]);
    } finally { await dispatcher.stop(); store.close(); }
  });
}
