/** Exercise prediction coordination over an actual local JSON-RPC WebSocket connection. */
import { describe, expect, it, onTestFinished } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexAppServerClient } from './codexAppServerClient';
import { createComposerPredictionHandlers } from './composerPrediction';

type Request = { id: number; method: string; params: Record<string, unknown> };
async function lab() {
    const dir = await mkdtemp(join(tmpdir(), 'paws-prediction-'));
    const socketPath = join(dir, 'rpc.sock');
    const server = createServer();
    const ws = new WebSocketServer({ server });
    const requests: Request[] = [];
    let connection: WebSocket;
    const arrivals: Array<{ method: string; resolve: (request: Request) => void }> = [];
    const reply = (id: number, result: unknown) => connection.send(JSON.stringify({ id, result }));
    ws.on('connection', socket => {
        connection = socket;
        socket.on('message', bytes => {
            const request = JSON.parse(bytes.toString()) as Request;
            requests.push(request);
            if (request.method === 'initialize') reply(request.id, { userAgent: 'prediction-lab' });
            if (request.method === 'thread/resume') reply(request.id, { thread: { id: 'parent' }, model: 'test-main', reasoningEffort: 'high' });
            if (request.method === 'thread/sample/cancel') reply(request.id, {});
            for (const pending of arrivals.splice(0)) {
                if (pending.method === request.method) pending.resolve(request);
                else arrivals.push(pending);
            }
        });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const client = new CodexAppServerClient(undefined, { type: 'unixSocket', socketPath }, {});
    await client.connect();
    await client.resumeThread({ threadId: 'parent' });
    let unsupported = 0;
    const handlers = createComposerPredictionHandlers({ client, isBusy: () => false, onUnsupported: () => unsupported++ });
    return {
        client, handlers, requests, reply,
        get unsupported() { return unsupported; },
        fail(id: number) { connection.send(JSON.stringify({ id, error: { code: -32601, message: 'Method not found' } })); },
        notify(method: string, params: unknown) { connection.send(JSON.stringify({ method, params })); },
        next(method: string) {
            return new Promise<Request>(resolve => arrivals.push({ method, resolve }));
        },
        async close() {
            await client.disconnect();
            for (const socket of ws.clients) socket.terminate();
            await new Promise<void>(resolve => ws.close(() => resolve()));
            await new Promise<void>(resolve => server.close(() => resolve()));
            await rm(dir, { recursive: true, force: true });
        },
    };
}

describe('composer prediction', () => {
    it('shares one inherited-model sample across devices and caches the result without root turn events', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const events: string[] = [];
        runtime.client.setEventHandler(event => events.push(event.type));
        const arrived = runtime.next('thread/sample');
        const first = runtime.handlers.request({ requestId: 'device-a', sourceTurnId: 'done' });
        const second = runtime.handlers.request({ requestId: 'device-b', sourceTurnId: 'done' });
        const sample = await arrived;
        expect(sample.params).toMatchObject({ threadId: 'parent', expectedTurnId: 'done', effort: 'low', disableMcp: true, interruptOnCancel: true });
        expect(sample.params).not.toHaveProperty('model');
        runtime.reply(sample.id, { sourceTurnId: 'done', responseId: 'r', text: 'Show me the preview.' });
        expect(await first).toEqual({ sourceTurnId: 'done', status: 'ready', text: 'Show me the preview.' });
        expect(await second).toEqual(await first);
        expect(await runtime.handlers.request({ requestId: 'device-c', sourceTurnId: 'done' })).toEqual(await first);
        expect(runtime.requests.filter(request => request.method === 'thread/sample')).toHaveLength(1);
        expect(runtime.requests.some(request => request.method === 'turn/start')).toBe(false);
        expect(events).toEqual([]);
    });

    it('keeps a concrete decision, fallback and execution boundary in a complete draft', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const text = '先做 B，结合上下文告诉我谁找我、什么事、需要我做什么，AI 失败也要正常提醒。先把目标和任务拆分对齐，暂时不要直接写代码。';
        const arrived = runtime.next('thread/sample');
        const prediction = runtime.handlers.request({ requestId: 'grounded', sourceTurnId: 'done' });
        runtime.reply((await arrived).id, { sourceTurnId: 'done', text });
        expect(await prediction).toEqual({ sourceTurnId: 'done', status: 'ready', text });
        expect((await runtime.handlers.request({ requestId: 'other-device', sourceTurnId: 'done' })).text).toBe(text);
        expect(runtime.requests.filter(request => request.method === 'thread/sample')).toHaveLength(1);
    });

    it.each(['好的。', '请继续！', '继续优化一下。', 'Okay!', 'Go ahead.', 'Keep optimizing.'])(
        'does not show the generic filler %s', async (text) => {
            const runtime = await lab(); onTestFinished(runtime.close);
            const arrived = runtime.next('thread/sample');
            const prediction = runtime.handlers.request({ requestId: 'filler', sourceTurnId: 'done' });
            runtime.reply((await arrived).id, { sourceTurnId: 'done', text });
            expect(await prediction).toEqual({ sourceTurnId: 'done', status: 'none' });
        },
    );

    it.each(['B', '先列出验收条件。', 'Compare low and medium on the same engineering conversations.'])(
        'preserves a specific short choice or action: %s', async (text) => {
            const runtime = await lab(); onTestFinished(runtime.close);
            const arrived = runtime.next('thread/sample');
            const prediction = runtime.handlers.request({ requestId: 'specific', sourceTurnId: 'done' });
            runtime.reply((await arrived).id, { sourceTurnId: 'done', text });
            expect((await prediction).text).toBe(text);
        },
    );

    it('normalizes paragraph whitespace without dropping useful constraints', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const arrived = runtime.next('thread/sample');
        const prediction = runtime.handlers.request({ requestId: 'paragraph', sourceTurnId: 'done' });
        runtime.reply((await arrived).id, { sourceTurnId: 'done', text: '先列出任务。\n\n暂时不要写代码。' });
        expect((await prediction).text).toBe('先列出任务。 暂时不要写代码。');
    });

    it.each(['<NO_SUGGESTION>', 'x'.repeat(241)])('omits an abstention or oversized draft', async (text) => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const arrived = runtime.next('thread/sample');
        const prediction = runtime.handlers.request({ requestId: 'none', sourceTurnId: 'done' });
        runtime.reply((await arrived).id, { sourceTurnId: 'done', text });
        expect((await prediction).status).toBe('none');
    });

    it('only cancels inference when the last subscriber leaves and uses the exact underlying request id', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const arrived = runtime.next('thread/sample');
        const first = runtime.handlers.request({ requestId: 'a', sourceTurnId: 'done' });
        const second = runtime.handlers.request({ requestId: 'b', sourceTurnId: 'done' });
        const sample = await arrived;
        runtime.handlers.cancel({ requestId: 'a' });
        expect(runtime.requests.filter(request => request.method === 'thread/sample/cancel')).toHaveLength(0);
        const cancelled = runtime.next('thread/sample/cancel');
        runtime.handlers.cancel({ requestId: 'b' });
        expect((await cancelled).params).toEqual({ requestId: sample.id });
        expect((await first).status).toBe('stale');
        expect((await second).status).toBe('stale');
        runtime.reply(sample.id, { sourceTurnId: 'done', text: 'Late result' });
        expect((await runtime.handlers.request({ requestId: 'c', sourceTurnId: 'done' })).status).toBe('stale');
        expect(runtime.requests.filter(request => request.method === 'thread/sample')).toHaveLength(1);
    });

    it('invalidates a pending prediction when a root turn starts without interrupting that turn', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const arrived = runtime.next('thread/sample');
        const prediction = runtime.handlers.request({ requestId: 'a', sourceTurnId: 'done' });
        const sample = await arrived;
        const cancelled = runtime.next('thread/sample/cancel');
        runtime.notify('turn/started', { threadId: 'parent', turn: { id: 'next', status: 'inProgress' } });
        expect((await cancelled).params.requestId).toBe(sample.id);
        expect((await prediction).status).toBe('stale');
        expect(runtime.client.turnId).toBe('next');
        expect(runtime.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
    });

    it('disables unsupported workers after one actual request', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const arrived = runtime.next('thread/sample');
        const prediction = runtime.handlers.request({ requestId: 'a', sourceTurnId: 'done' });
        runtime.fail((await arrived).id);
        expect((await prediction).status).toBe('unsupported');
        expect((await runtime.handlers.request({ requestId: 'b', sourceTurnId: 'another' })).status).toBe('unsupported');
        expect(runtime.unsupported).toBe(1);
        expect(runtime.requests.filter(request => request.method === 'thread/sample')).toHaveLength(1);
    });

    it('returns no candidate for tool-only responses and rejects caller-supplied prompts', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        await expect(runtime.handlers.request({ requestId: 'x', sourceTurnId: 'done', prompt: 'run commands' } as never)).rejects.toThrow();
        const arrived = runtime.next('thread/sample');
        const prediction = runtime.handlers.request({ requestId: 'a', sourceTurnId: 'done' });
        runtime.reply((await arrived).id, { sourceTurnId: 'done', text: null });
        expect((await prediction).status).toBe('none');
    });

    it('cancels upstream on the one-shot deadline without retrying', async () => {
        const runtime = await lab(); onTestFinished(runtime.close);
        const arrived = runtime.next('thread/sample');
        const cancelled = runtime.next('thread/sample/cancel');
        const prediction = runtime.handlers.request({ requestId: 'a', sourceTurnId: 'done' });
        const sample = await arrived;
        expect((await cancelled).params.requestId).toBe(sample.id);
        expect((await prediction).status).toBe('failed');
        expect(runtime.requests.filter(request => request.method === 'thread/sample')).toHaveLength(1);
    }, 25_000);
});
