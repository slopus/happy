import { describe, expect, it, vi } from 'vitest';
import { cleanupStdinAfterInk } from './terminalStdinCleanup';

function createFakeStdin() {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const calls: Array<{ name: string; args: any[] }> = [];

    const api = {
        isTTY: true,
        on: (event: string, fn: (...args: any[]) => void) => {
            calls.push({ name: 'on', args: [event] });
            const set = listeners.get(event) ?? new Set();
            set.add(fn);
            listeners.set(event, set);
            return api as any;
        },
        off: (event: string, fn: (...args: any[]) => void) => {
            calls.push({ name: 'off', args: [event] });
            listeners.get(event)?.delete(fn);
            return api as any;
        },
        resume: () => {
            calls.push({ name: 'resume', args: [] });
        },
        pause: () => {
            calls.push({ name: 'pause', args: [] });
        },
        setRawMode: (value: boolean) => {
            calls.push({ name: 'setRawMode', args: [value] });
        },
        __calls: calls,
        __listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
        __emit: (event: string, payload: unknown) => {
            for (const fn of listeners.get(event) ?? []) fn(payload);
        },
    };

    return api;
}

describe('cleanupStdinAfterInk', () => {
    it('keeps raw mode enabled during the drain window and pauses stdin', async () => {
        vi.useFakeTimers();
        const stdin = createFakeStdin();

        const promise = cleanupStdinAfterInk({ stdin: stdin as any, drainMs: 50 });
        await vi.advanceTimersByTimeAsync(60);
        await promise;

        // Raw mode is asserted true at the start.
        const setRawModeCalls = stdin.__calls.filter((c) => c.name === 'setRawMode');
        expect(setRawModeCalls[0]?.args[0]).toBe(true);
        // No setRawMode(false) by default — next consumer (claude) takes over.
        expect(setRawModeCalls.some((c) => c.args[0] === false)).toBe(false);

        expect(stdin.__calls.some((c) => c.name === 'resume')).toBe(true);
        expect(stdin.__calls.some((c) => c.name === 'pause')).toBe(true);
        expect(stdin.__listenerCount('data')).toBe(0);

        vi.useRealTimers();
    });

    it('restores raw mode to cooked when leaveRawMode is false', async () => {
        vi.useFakeTimers();
        const stdin = createFakeStdin();

        const promise = cleanupStdinAfterInk({ stdin: stdin as any, drainMs: 20, leaveRawMode: false });
        await vi.advanceTimersByTimeAsync(30);
        await promise;

        const setRawModeCalls = stdin.__calls.filter((c) => c.name === 'setRawMode');
        expect(setRawModeCalls[0]?.args[0]).toBe(true);
        expect(setRawModeCalls.at(-1)?.args[0]).toBe(false);

        vi.useRealTimers();
    });

    it('skips drain phase when drainMs is 0 and just pauses stdin', async () => {
        const stdin = createFakeStdin();
        await cleanupStdinAfterInk({ stdin: stdin as any, drainMs: 0 });

        expect(stdin.__calls.some((c) => c.name === 'pause')).toBe(true);
        expect(stdin.__calls.some((c) => c.name === 'resume')).toBe(false);
        expect(stdin.__calls.some((c) => c.name === 'on')).toBe(false);
    });

    it('reports drained byte count to onDebug', async () => {
        vi.useFakeTimers();
        const stdin = createFakeStdin();
        const events: any[] = [];

        const promise = cleanupStdinAfterInk({
            stdin: stdin as any,
            drainMs: 30,
            onDebug: (e) => events.push(e),
        });

        // Simulate user typing during the drain window.
        stdin.__emit('data', Buffer.from('  abc'));
        await vi.advanceTimersByTimeAsync(40);
        await promise;

        expect(events).toEqual([{ kind: 'drain-byte-count', bytes: 5, chunks: 1 }]);
        vi.useRealTimers();
    });

    it('is a no-op when stdin is not a TTY', async () => {
        const stdin = createFakeStdin();
        (stdin as any).isTTY = false;
        await cleanupStdinAfterInk({ stdin: stdin as any, drainMs: 50 });
        expect(stdin.__calls.length).toBe(0);
    });
});
