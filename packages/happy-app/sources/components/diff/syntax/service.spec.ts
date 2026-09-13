import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyntaxService, syntaxKey } from './service';
import type { SyntaxInput, SyntaxResult } from './protocol';
import { SyntaxWorkerUnavailableError } from './protocol';

const input = (text: string, language = 'typescript'): SyntaxInput => ({ language, lines: [{ type: 'add', text }] });
const result: SyntaxResult = { status: 'highlighted', runs: [[{ k: 'keyword', n: 5 }]], computeMs: 3 };
function setup() {
    const work: { resolve: (value: SyntaxResult) => void; reject: (error: Error) => void }[] = [];
    const run = vi.fn((_input: SyntaxInput) => new Promise<SyntaxResult>((resolve, reject) => work.push({ resolve, reject })));
    const log = vi.fn();
    const service = new SyntaxService({ run }, log);
    return { service, run, work, log };
}

describe('syntax queue and LRU', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
    afterEach(() => vi.useRealTimers());

    it('deduplicates in-flight consumers and returns cached results on remount', async () => {
        const { service, run, work } = setup();
        const a = service.request(input('const'));
        const b = service.request(input('const'));
        await vi.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(1);
        a.cancel();
        expect((await a.promise).status).toBe('cancelled');
        work[0].resolve(result);
        expect((await b.promise).status).toBe('highlighted');
        expect((await service.request(input('const')).promise).result).toBe(result);
        expect(run).toHaveBeenCalledTimes(1);
        expect(service.getStats().hits).toBe(1);
    });

    it('prioritizes visible content over mounted-ahead work, without preempting a running job', async () => {
        const { service, run, work } = setup();
        service.request(input('ahead'), 1);
        service.request(input('visible'), 2);
        await vi.advanceTimersByTimeAsync(0);
        expect(run.mock.calls[0][0]).toEqual(input('visible'));
        service.request(input('new visible'), 2);
        work[0].resolve(result);
        await vi.advanceTimersByTimeAsync(1);
        expect(run.mock.calls[1][0]).toEqual(input('new visible'));
    });

    it('updates priority and drops unmounted queued work', async () => {
        const { service, run } = setup();
        const removed = service.request(input('removed'), 2);
        const promoted = service.request(input('promoted'), 1);
        service.request(input('ordinary'), 1);
        promoted.setPriority(2);
        removed.cancel();
        await vi.advanceTimersByTimeAsync(0);
        expect(run.mock.calls[0][0]).toEqual(input('promoted'));
        expect(service.peek(syntaxKey(input('removed')))).toBeUndefined();
    });

    it('includes queue wait in the one-second deadline; a stuck runtime never spawns replacements', async () => {
        const { service, run } = setup();
        const running = service.request(input('running'), 2);
        const queued = service.request(input('queued'), 1);
        await vi.advanceTimersByTimeAsync(999);
        expect(service.getStats().timeouts).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect((await running.promise).status).toBe('timeout');
        expect((await queued.promise).status).toBe('timeout');
        const next = service.request(input('next'));
        await vi.advanceTimersByTimeAsync(1000);
        expect((await next.promise).status).toBe('timeout');
        expect(run).toHaveBeenCalledTimes(1);
        expect(service.getStats()).toMatchObject({ timeouts: 3, running: true, queued: 0 });
        expect(service.peek(syntaxKey(input('queued')))).toBeUndefined();
        expect(service.peek(syntaxKey(input('next')))).toBeUndefined();
    });

    it('gives each consumer its own deadline and retries dropped queue work on a later visit', async () => {
        const { service, run, work } = setup();
        const first = service.request(input('running'));
        const queued = service.request(input('queued'));
        await vi.advanceTimersByTimeAsync(600);
        const later = service.request(input('running'));
        await vi.advanceTimersByTimeAsync(400);
        expect((await first.promise).status).toBe('timeout');
        expect((await queued.promise).status).toBe('timeout');
        expect(service.getStats().timeouts).toBe(2);
        work[0].resolve(result);
        expect((await later.promise).status).toBe('highlighted');
        const retry = service.request(input('queued'));
        await vi.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledTimes(2);
        work[1].resolve(result);
        expect((await retry.promise).status).toBe('highlighted');
    });

    it('keeps late results in the cache without changing the already settled promise', async () => {
        const { service, work } = setup();
        const request = service.request(input('const'));
        await vi.advanceTimersByTimeAsync(1000);
        const revealed = await request.promise;
        work[0].resolve(result);
        await vi.advanceTimersByTimeAsync(1);
        expect(revealed.status).toBe('timeout');
        expect(service.peek(syntaxKey(input('const')))?.status).toBe('highlighted');
    });

    it('does not confuse languages or contents and bounds large input before dispatch', async () => {
        expect(syntaxKey(input('same', 'typescript'))).not.toBe(syntaxKey(input('same', 'python')));
        expect(syntaxKey(input('one'))).not.toBe(syntaxKey(input('two')));
        const { service, run } = setup();
        expect((await service.request(input('x'.repeat(2001))).promise).status).toBe('limited');
        expect(run).not.toHaveBeenCalled();
    });

    it('fails plain when the native module/worker is unavailable, without retry storms', async () => {
        const { service, run, work } = setup();
        const first = service.request(input('first'));
        const queued = service.request(input('queued'));
        await vi.advanceTimersByTimeAsync(0);
        work[0].reject(new SyntaxWorkerUnavailableError('module unavailable'));
        await vi.advanceTimersByTimeAsync(1);
        expect((await first.promise).status).toBe('error');
        expect((await queued.promise).status).toBe('error');
        expect((await service.request(input('later')).promise).status).toBe('error');
        expect(run).toHaveBeenCalledTimes(1);
        expect(service.peek(syntaxKey(input('first')))).toBeUndefined();
    });

    it('contains one input failure without disabling highlighting for other files', async () => {
        const { service, run, work } = setup();
        const bad = service.request(input('bad'));
        const good = service.request(input('good'));
        await vi.advanceTimersByTimeAsync(0);
        work[0].reject(new Error('bad input'));
        await vi.advanceTimersByTimeAsync(1);
        expect((await bad.promise).status).toBe('error');
        expect(run).toHaveBeenCalledTimes(2);
        work[1].resolve(result);
        expect((await good.promise).status).toBe('highlighted');
    });
});