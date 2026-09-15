import { createServer, type ServerResponse } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { PawsAgentClient } from './PawsAgentClient';
import { encodeBase64, encrypt } from '../crypto/encryption';
import type { PawsAgentEvent } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
    const key = new Uint8Array(32);
    const seal = (value: unknown) => ({ t: 'encrypted', c: encodeBase64(encrypt(key, 'legacy', value)) });
    const message = (seq: number) => ({ id: `m${seq}`, seq, content: seal({ text: `message ${seq}` }), localId: null, createdAt: 10000 - seq, updatedAt: 1 });
    const session = { id: 's', seq: 0, metadata: seal({}).c, metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, active: true, activeAt: 1, createdAt: 1, updatedAt: 1 };
    const state = { rows: [] as ReturnType<typeof message>[], requests: [] as URL[], hold: null as null | ((response: ServerResponse, payload: unknown) => void), sessionHold: null as null | ((response: ServerResponse, payload: unknown) => void), overlap: false, status: 200, failures: 0 };
    const server = createServer((request, response) => {
        const url = new URL(request.url!, 'http://localhost');
        response.setHeader('Content-Type', 'application/json');
        if (url.pathname.includes('/messages')) {
            state.requests.push(url);
            response.statusCode = state.failures-- > 0 ? 503 : state.status;
            const after = Number(url.searchParams.get('after_seq') ?? -1);
            const before = Number(url.searchParams.get('before_seq') ?? Infinity);
            const limit = Number(url.searchParams.get('limit'));
            const rows = state.rows.filter(row => row.seq > after && row.seq < before).sort((a, b) => after >= 0 ? a.seq - b.seq : b.seq - a.seq);
            const page = rows.slice(0, limit);
            if (state.overlap && after > 0) page.unshift(message(after));
            const payload = { messages: page, hasMore: rows.length > limit };
            if (state.hold) state.hold(response, payload);
            else response.end(JSON.stringify(payload));
        } else {
            const payload = url.pathname === '/v1/machines' ? [] : url.pathname === '/v1/sessions' ? { sessions: [session] } : { session: { ...session, id: url.pathname.split('/').at(-1) } };
            if (state.sessionHold && url.pathname.startsWith('/v2/sessions/')) state.sessionHold(response, payload);
            else response.end(JSON.stringify(payload));
        }
    });
    const io = new Server(server, { path: '/v1/updates', transports: ['websocket'] });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new PawsAgentClient({ serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, credentials: { getCredentials: async () => ({ token: 'fixture', secret: key, contentKeyPair: { publicKey: key, secretKey: key } }), setCredentials: async () => {}, clearCredentials: async () => {} }, reconnect: { initialDelayMs: 10, maxDelayMs: 20 } });
    const events: PawsAgentEvent[] = [];
    client.subscribe(event => events.push(event));
    cleanups.push(async () => { await client.dispose(); await new Promise<void>(resolve => io.close(() => resolve())); });
    await client.connect();
    const announce = (seq: unknown) => io.emit('update', { body: { t: 'new-message', sid: 's', message: { ...message(1), seq } } });
    return { state, client, io, message, seal, announce, events };
}

it('catches up more than 500 messages in seq order, then recovers batch gaps without duplicates', async () => {
    const f = await fixture();
    f.state.rows = Array.from({ length: 1100 }, (_, index) => f.message(index + 1));
    f.state.overlap = true;
    const seen: number[] = [];
    const watch = await f.client.messages.watch('s', { afterSeq: 0, onMessage: message => seen.push(message.seq) });
    expect(seen).toEqual(Array.from({ length: 1100 }, (_, index) => index + 1));
    expect(f.state.requests.map(url => url.searchParams.get('after_seq'))).toEqual(['0', '500', '1000']);
    f.state.rows.push(f.message(1101), f.message(1102), f.message(1103));
    f.announce(1103); f.announce(1103); f.announce(1101);
    await vi.waitFor(() => expect(seen.at(-1)).toBe(1103));
    expect(seen.length).toBe(1103);
    expect(f.state.requests.slice(3).every(url => Number(url.searchParams.get('after_seq')) >= 1100)).toBe(true);
    watch.unsubscribe();
});

it('registers live hints before initial catch-up and serializes concurrent sync calls', async () => {
    const f = await fixture();
    let release!: () => void;
    f.state.hold = (response, payload) => { release = () => response.end(JSON.stringify(payload)); };
    const seen: number[] = [];
    const pending = f.client.messages.watch('s', { afterSeq: 0, onMessage: message => seen.push(message.seq) });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.state.rows.push(f.message(1)); f.announce(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    f.state.hold = null; release();
    const watch = await pending;
    expect(seen).toEqual([1]);
    await Promise.all([watch.sync(), watch.sync(), watch.sync()]);
    expect(seen).toEqual([1]);
});

it('replays disconnected messages before reconnect ready and surfaces resync failures', async () => {
    const f = await fixture();
    const order: string[] = [];
    f.client.subscribe(event => { if (event.type === 'connection' && event.state === 'ready') order.push('ready'); });
    await f.client.messages.watch('s', { afterSeq: 0, onMessage: message => order.push(`m${message.seq}`) });
    f.state.rows.push(f.message(1), f.message(2));
    for (const socket of f.io.sockets.sockets.values()) socket.conn.close();
    await vi.waitFor(() => expect(order).toEqual(['m1', 'm2', 'ready']));
    order.length = 0; f.state.status = 500;
    for (const socket of f.io.sockets.sockets.values()) socket.conn.close();
    await vi.waitFor(() => expect(f.events.some(event => event.type === 'error')).toBe(true));
    expect(order).toEqual([]);
});

it.each(['gap', 'missing-seq', 'decrypt'] as const)('fails closed for %s without skipping to a later message', async kind => {
    const f = await fixture();
    const seen: number[] = []; const errors: unknown[] = [];
    const watch = await f.client.messages.watch('s', { afterSeq: 0, onMessage: message => seen.push(message.seq), onError: error => errors.push(error) });
    const broken = f.message(kind === 'gap' ? 2 : 1);
    if (kind === 'decrypt') broken.content.c = 'AAAA';
    f.state.rows.push(broken, f.message(3));
    f.announce(kind === 'missing-seq' ? undefined : 3);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(seen).toEqual([]);
    await expect(watch.sync()).rejects.toBeDefined();
});

it('aborts an in-flight watch promptly and emits nothing after cancellation or disposal', async () => {
    const f = await fixture();
    const controller = new AbortController(); const seen: number[] = [];
    let release!: () => void;
    f.state.rows.push(f.message(1));
    f.state.hold = (response, payload) => { release = () => response.end(JSON.stringify(payload)); };
    const pending = f.client.messages.watch('s', { afterSeq: 0, signal: controller.signal, onMessage: message => seen.push(message.seq) });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort(); await rejected; release(); f.state.hold = null;
    f.announce(1); await f.client.dispose();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen).toEqual([]);
});

it('supports forward/backward page cursors and preserves default history ordering', async () => {
    const f = await fixture(); f.state.rows = [f.message(1), f.message(2), f.message(3)];
    expect((await f.client.messages.history('s', { limit: 2 })).map(message => message.seq)).toEqual([3, 2]);
    const page = await f.client.messages.historyPage('s', { afterSeq: 0, limit: 2 });
    expect(page.messages.map(message => message.seq)).toEqual([1, 2]); expect(page.hasMore).toBe(true);
    expect((await f.client.messages.history('s', { beforeSeq: 3 })).map(message => message.seq)).toEqual([1, 2]);
    await expect(f.client.messages.history('s', { afterSeq: 0, beforeSeq: 2 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
});

it('decrypts ordered cumulative text hints, rejects plaintext/unknown payloads, and never persists hints', async () => {
    const f = await fixture();
    const stream = { type: 'text-delta', turnId: 't1', itemId: 'i1', delta: 'hel', text: 'hel' };
    f.io.emit('session-stream', { sid: 's', content: f.seal(stream) });
    f.io.emit('session-stream', { sid: 's', content: f.seal({ ...stream, delta: 'o', text: 'hello' }) });
    f.io.emit('session-stream', { sid: 's', content: { t: 'plain', c: stream } });
    f.io.emit('session-stream', { sid: 's', content: f.seal({ type: 'unknown', secret: 'DO NOT EMIT' }) });
    await vi.waitFor(() => expect(f.events.filter(event => event.type === 'text-delta')).toHaveLength(2));
    expect(f.events.filter(event => event.type === 'text-delta')).toEqual([{ ...stream, sessionId: 's' }, { ...stream, sessionId: 's', delta: 'o', text: 'hello' }]);
    expect(f.events.filter(event => event.type === 'message')).toEqual([]);
    expect(JSON.stringify(f.events)).not.toContain('DO NOT EMIT');
});

it('recovers the final notification after a transient HTTP failure without another notification', async () => {
    const f = await fixture(); const seen: number[] = [];
    await f.client.messages.watch('s', { afterSeq: 0, onMessage: message => seen.push(message.seq) });
    f.state.failures = 1; f.state.rows.push(f.message(1)); f.announce(1);
    await vi.waitFor(() => expect(seen).toEqual([1]));
});

it('retries failed reconnect catch-up and eventually becomes ready without another socket reconnect', async () => {
    const f = await fixture(); const seen: number[] = [];
    await f.client.messages.watch('s', { afterSeq: 0, onMessage: message => seen.push(message.seq) });
    f.events.length = 0; f.state.status = 503; f.state.rows.push(f.message(1));
    for (const socket of f.io.sockets.sockets.values()) socket.conn.close();
    await vi.waitFor(() => expect(f.events.some(event => event.type === 'error')).toBe(true));
    expect(f.events.some(event => event.type === 'connection' && event.state === 'ready')).toBe(false);
    f.state.status = 200;
    await vi.waitFor(() => expect(f.events.some(event => event.type === 'connection' && event.state === 'ready')).toBe(true));
    expect(seen).toEqual([1]);
});

it('does not hold reconnect readiness when a subscriber unsubscribes during catch-up', async () => {
    const f = await fixture();
    const watch = await f.client.messages.watch('s', { afterSeq: 0, onMessage: () => watch.unsubscribe() });
    f.events.length = 0; f.state.rows.push(f.message(1), f.message(2));
    for (const socket of f.io.sockets.sockets.values()) socket.conn.close();
    await vi.waitFor(() => expect(f.events.some(event => event.type === 'connection' && event.state === 'ready')).toBe(true));
    expect(f.events.filter(event => event.type === 'error')).toEqual([]);
});

it('suppresses readiness from a superseded reconnect while its HTTP read is still in flight', async () => {
    const f = await fixture(); const seen: number[] = [];
    await f.client.messages.watch('s', { afterSeq: 0, onMessage: message => seen.push(message.seq) });
    let release!: () => void;
    f.state.hold = (response, payload) => { release = () => response.end(JSON.stringify(payload)); };
    f.events.length = 0;
    for (const socket of f.io.sockets.sockets.values()) socket.conn.close();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    for (const socket of f.io.sockets.sockets.values()) socket.conn.close();
    await vi.waitFor(() => expect(f.events.filter(event => event.type === 'connection' && event.state === 'syncing')).toHaveLength(2));
    f.state.rows.push(f.message(1)); f.state.hold = null; release();
    await vi.waitFor(() => expect(f.events.filter(event => event.type === 'connection' && event.state === 'ready')).toHaveLength(1));
    expect(seen).toEqual([1]);
});

it('preserves stream arrival order during asynchronous key retrieval and suppresses late events after dispose', async () => {
    const f = await fixture(); let release!: () => void;
    f.state.sessionHold = (response, payload) => { release = () => response.end(JSON.stringify(payload)); };
    const hint = (sid: string, text: string) => f.io.emit('session-stream', { sid, content: f.seal({ type: 'text-delta', turnId: 'turn', itemId: 'item', delta: text, text }) });
    hint('other', 'first'); hint('s', 'second');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.events.filter(event => event.type === 'text-delta')).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(f.events.filter(event => event.type === 'text-delta')).toHaveLength(2));
    expect(f.events.filter(event => event.type === 'text-delta').map(event => event.text)).toEqual(['first', 'second']);
    release = undefined!; hint('another', 'late');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.client.dispose(); release();
    const count = f.events.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.events.length).toBe(count);
});

it('delivers live text while a metadata lookup is stalled', async () => {
    const f = await fixture(); let release!: () => void;
    f.state.sessionHold = (response, payload) => { release = () => response.end(JSON.stringify(payload)); };
    f.io.emit('update', { body: { t: 'update-session', id: 's' } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.io.emit('session-stream', { sid: 's', content: f.seal({ type: 'text-delta', turnId: 't', itemId: 'i', delta: 'live', text: 'live' }) });
    try { await vi.waitFor(() => expect(f.events.filter(event => event.type === 'text-delta')).toHaveLength(1)); }
    finally { release(); }
});

it('bounds provisional snapshots while stream key retrieval is stalled and retains the newest text', async () => {
    const f = await fixture(); let release!: () => void;
    f.state.sessionHold = (response, payload) => { release = () => response.end(JSON.stringify(payload)); };
    for (let index = 0; index < 100; index++) f.io.emit('session-stream', { sid: 'other', content: f.seal({ type: 'text-delta', turnId: 't', itemId: 'i', delta: `${index}`, text: `${index}` }) });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise(resolve => setTimeout(resolve, 30)); release();
    await vi.waitFor(() => expect(f.events.filter(event => event.type === 'text-delta').at(-1)).toMatchObject({ text: '99' }));
    expect(f.events.filter(event => event.type === 'text-delta').length).toBeLessThanOrEqual(9);
});
