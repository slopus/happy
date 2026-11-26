/** No business polling: snapshots arrive over authenticated SSE, submits and manual recovery wake once. */
import { uuid } from './store.mjs';
import { openEventStream } from './events.mjs';
export async function consumeEvents(response, onState) {
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('event-connection-failed');
  let pending = ''; const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true });
    if (pending.length > 1_000_000) throw new Error('event-too-large');
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (data) await onState(JSON.parse(data));
    }
  }
}
export function createDispatcher({ store, origin, taskId, token, changed, fetchImpl = fetch, openEvents = openEventStream }) {
  const auth = { authorization: `Bearer ${token}` };
  let connected = false, busy = false, dirty = false, snapshot = null, stopped = false, connection;
  let controller = new AbortController();
  const connectionState = () => connected ? 'connected' : 'disconnected';
  const disconnect = () => { connected = false; controller.abort(); changed(); };
  async function wake() {
    if (stopped || !connected) return;
    dirty = true; if (busy) return; busy = true;
    try {
      do {
        dirty = false;
        // Reconcile only our jobs. A completed agent/handler without uploaded
        // assets is a failure, never a fabricated finished card.
        for (const remote of snapshot?.runs ?? []) {
          let job; try { job = store.get(remote.requestId); } catch { continue; }
          if (['completed', 'failed'].includes(job.state)) continue;
          if (!job.runId && job.state !== 'queued') job = store.bind(job.id, remote.runId);
          if (job.runId !== remote.runId) continue;
          if (['failed', 'cancelled', 'skipped'].includes(remote.status)) store.update(job.id, { state: 'failed', error: 'execution-failed' });
          else if (remote.status === 'uncertain') store.update(job.id, { state: 'uncertain', error: 'execution-uncertain' });
          else if (remote.status === 'completed' && !job.manifest) store.update(job.id, { state: 'failed', error: 'result-missing' });
        }
        changed();
        if (snapshot?.activeRunId) continue;
        const pending = store.outstanding();
        // Only an ambiguous HTTP delivery may safely retry using the SAME key.
        const job = pending?.state === 'dispatching' ? pending : !pending ? store.next() : null;
        if (!job) continue;
        store.update(job.id, { state: 'dispatching', error: null }); changed();
        try {
          const response = await fetchImpl(`${origin}/v1/task-webhooks/${taskId}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: job.id, input: { jobId: job.id } }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          // Parsing and acknowledgement validation are part of delivery. A proxy
          // error or truncated 202 cannot tell us whether the run was accepted.
          const data = await response.json();
          if (stopped) break;
          if (response.ok) {
            if (response.status !== 202 || uuid(data.requestId) !== job.id) throw new Error('invalid-acceptance');
            uuid(data.runId);
            if (!['completed', 'failed'].includes(store.get(job.id).state)) store.bind(job.id, data.runId);
          } else if (response.status === 409 && data.error === 'task-busy') store.update(job.id, { state: 'queued' });
          else { store.update(job.id, { error: response.status === 401 ? 'trigger-disabled' : 'trigger-unavailable' }); disconnect(); }
        } catch { disconnect(); break; }
        changed();
      } while (dirty && connected && !stopped);
    } catch { disconnect();
    } finally { busy = false; }
  }
  function connect() {
    if (connection || stopped) return connection;
    connection = (async () => {
      try {
        const response = await openEvents(`${origin}/v1/task-webhooks/${taskId}/events`, { headers: auth, signal: controller.signal });
        await consumeEvents(response, async value => {
          if (!value || !Array.isArray(value.runs)) throw new Error('invalid-snapshot');
          snapshot = value; connected = true; await wake();
        });
      } catch { /* Explicitly visible offline; no retry loop or hidden resubmission. */ }
      finally { connected = false; connection = null; if (!stopped) changed(); }
    })();
    return connection;
  }
  return { wake, connect, connectionState,
    async reconnect() { if (stopped) return; controller.abort(); await connection; controller = new AbortController(); void connect(); },
    async stop() { stopped = true; controller.abort(); await connection; },
  };
}
