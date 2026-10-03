import { describe, expect, it, vi } from 'vitest';
import { createCodexTurnLatency, captureCodexLatencyTrace, type CodexLatencyStage } from './codexTurnLatency';

describe('Codex opt-in turn latency', () => {
    it('lets the normal text preview send before emitting the first-text diagnostic', async () => {
        const emit = vi.fn();
        const trace = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'trace', receivedAt: 0 }] }, emit, () => 10)!;
        trace.submitted(); emit.mockClear(); trace.text('OK');
        expect(emit).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'text', firstSdkTextMs: 10 }));
    });
    it('stops claiming exclusive attribution when steering joins an active turn', () => {
        const emit = vi.fn();
        const trace = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'one', receivedAt: 0 }] }, emit, () => 10)!;
        trace.submitted(); trace.steered(); trace.text('OK'); trace.finish('completed');
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ attribution: 'coalesced', inputCount: 2 }));
    });
    it('reports input receipt before queue or startup processing and keeps optional observer failures isolated', () => {
        const emit = vi.fn();
        expect(captureCodexLatencyTrace({ id: 'trace' }, emit, () => 10)).toEqual({ id: 'trace', receivedAt: 10 });
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'received', sequence: 0, queueMs: null, sdkSubmitMs: null }));
        expect(captureCodexLatencyTrace({ id: 'trace' }, () => { throw Error('observer'); }, () => 10)).toEqual({ id: 'trace', receivedAt: 10 });
        expect(captureCodexLatencyTrace({ id: 'trace' }, emit, () => NaN)).toBeUndefined();
        const clock = vi.fn(); captureCodexLatencyTrace(undefined, emit, clock);
        expect(clock).not.toHaveBeenCalled();
    });

    it.each(['mcp-sync', 'mcp-inventory', 'mcp-reconnect', 'mcp-backoff', 'mcp-verification'] as CodexLatencyStage[])('reports pending %s before a stalled operation finishes', async stage => {
        let clock = 10;
        const emit = vi.fn();
        const trace = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'trace', receivedAt: 0 }] }, emit, () => clock)!;
        let release!: () => void;
        clock = 20;
        const pending = trace.measure(stage, () => new Promise<void>(resolve => { release = resolve; }));
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'turn-latency-progress', phase: 'preparing', queueMs: 10,
            preparation: [{ stage, startedMs: 20, durationMs: null, outcome: 'pending' }],
        }));
        clock = 45; release(); await pending;
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
            preparation: [{ stage, startedMs: 20, durationMs: 25, outcome: 'resolved' }],
        }));
    });

    it('keeps queue included in submit time and distinguishes first activity, text, and terminal', () => {
        let clock = 10;
        const emit = vi.fn();
        const trace = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'trace', receivedAt: 0 }] }, emit, () => clock)!;
        clock = 20; trace.submitted(); clock = 30; trace.activity();
        clock = 40; trace.text(''); trace.text('OK'); clock = 50; trace.text('later'); trace.finish('completed');
        expect(emit.mock.calls.map(([frame]) => frame)).toContainEqual(expect.objectContaining({
            type: 'turn-latency-progress', phase: 'completed', firstActivityMs: 30, firstSdkTextMs: 40,
        }));
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'turn-latency', queueMs: 10, sdkSubmitMs: 20, firstSdkTextMs: 40, outcome: 'text',
        }));
        const count = emit.mock.calls.length;
        trace.activity(); trace.text('late'); trace.finish('failed');
        expect(emit).toHaveBeenCalledTimes(count);
    });

    it('retains all merged traces without claiming exclusive attribution', () => {
        const emit = vi.fn();
        createCodexTurnLatency({ inputCount: 3, latencyTraces: [{ id: 'one', receivedAt: 0 }, { id: 'two', receivedAt: 5 }] }, emit, () => 10);
        expect(emit.mock.calls.map(([frame]) => [frame.id, frame.attribution, frame.inputCount, frame.queueMs]))
            .toEqual([['one', 'coalesced', 3, 10], ['two', 'coalesced', 3, 5]]);
    });

    it('does no diagnostic work for inputs without an opt-in trace', () => {
        const clock = vi.fn(); const emit = vi.fn();
        expect(createCodexTurnLatency({ inputCount: 1, latencyTraces: [] }, emit, clock)).toBeNull();
        expect(clock).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
    });

    it('preserves the original preparation rejection when diagnostics throw', async () => {
        const failure = new Error('operation failed');
        const trace = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'trace', receivedAt: 0 }] }, () => { throw new Error('observer failed'); }, () => 10)!;
        await expect(trace.measure('thread-start', () => Promise.reject(failure))).rejects.toBe(failure);
        expect(() => trace.finish('failed')).not.toThrow();
    });

    it('reports an invalid clock as missing instead of fabricating successful latency', () => {
        const emit = vi.fn();
        const trace = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'trace', receivedAt: 0 }] }, emit, () => NaN)!;
        trace.submitted(); trace.text('OK'); trace.finish('completed');
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'turn-latency-progress', elapsedMs: null, sdkSubmitMs: null, firstSdkTextMs: null, clockFailures: expect.any(Number),
        }));
        expect(emit.mock.calls.some(([frame]) => frame.type === 'turn-latency')).toBe(false);
    });

    it('bounds preparation records and excludes text and raw failures from diagnostics', async () => {
        const emit = vi.fn();
        const trace = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'trace', receivedAt: 0 }] }, emit, () => 10)!;
        for (let i = 0; i < 40; i++) await trace.measure('mcp-status', async () => 'private result');
        trace.submitted(); trace.text('private text'); trace.finish('failed');
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ preparation: expect.any(Array), droppedSpans: 8 }));
        expect(emit.mock.calls.at(-1)![0].preparation).toHaveLength(32);
        expect(JSON.stringify(emit.mock.calls)).not.toContain('private');
    });
});
