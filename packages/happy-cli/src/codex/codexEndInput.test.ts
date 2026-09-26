/**
 * Codex's graceful close, against the real method on the real class.
 *
 * `disconnect()` does `stdin.end()` and `SIGTERM` in one breath and never
 * awaits the exit, so it can never prove a flush. Every case here is a way
 * `endInputAndAwaitExit` could report one that did not happen.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from './codexAppServerClient';

/** A stand-in for the spawned app server, recording every signal sent. */
function processDouble() {
    const proc = new EventEmitter() as EventEmitter & {
        pid: number;
        stdin: { end: () => void } | null;
        kill: (signal?: string) => boolean;
    };
    const signals: string[] = [];
    let stdinEnded = 0;
    proc.pid = 4242;
    proc.stdin = { end: () => { stdinEnded += 1; } };
    proc.kill = (signal?: string) => { signals.push(signal ?? 'SIGTERM'); return true; };
    return { proc, signals, endedCount: () => stdinEnded };
}

/**
 * The real prototype with only `process` supplied.
 *
 * `process` is private, so the cast goes through `unknown` — the method under
 * test is the real one either way, which is the part that matters.
 */
function client(proc: unknown): { endInputAndAwaitExit: CodexAppServerClient['endInputAndAwaitExit'] } {
    const instance = Object.create(CodexAppServerClient.prototype) as unknown as { process: unknown };
    instance.process = proc;
    return instance as unknown as { endInputAndAwaitExit: CodexAppServerClient['endInputAndAwaitExit'] };
}

describe('endInputAndAwaitExit', () => {
    afterEach(() => vi.useRealTimers());
    it('cancels an exit observation and releases its listener without signalling', async () => {
        const { proc, signals } = processDouble(); const controller = new AbortController();
        const pending = client(proc).endInputAndAwaitExit(1000, controller.signal);
        controller.abort();
        expect(await pending).toEqual({ exited: false, code: null, signal: null });
        expect(proc.listenerCount('exit')).toBe(0); expect(signals).toEqual([]);
    });

    it('shouldEndStdinAndSendNoSignalAtAll', async () => {
        const { proc, signals, endedCount } = processDouble();
        const instance = client(proc);

        const settled = instance.endInputAndAwaitExit(1_000);
        proc.emit('exit', 0, null);

        expect(await settled).toEqual({ exited: true, code: 0, signal: null });
        expect(endedCount()).toBe(1);
        // The whole point: a signalled process did not flush.
        expect(signals).toEqual([]);
    });

    it('shouldReportWhatTheKernelSaidRatherThanWhatWasHopedFor', async () => {
        const { proc } = processDouble();
        const instance = client(proc);

        const settled = instance.endInputAndAwaitExit(1_000);
        proc.emit('exit', 3, null);

        expect(await settled).toEqual({ exited: true, code: 3, signal: null });
    });

    it('shouldNotCallATimeoutAnExit', async () => {
        // A budget that ran out is "not observed leaving", and folding it into
        // a clean exit is how a still-writing provider gets archived. The
        // caller may fall back to `disconnect()`, but that is a kill.
        const { proc, signals } = processDouble();
        const instance = client(proc);

        expect(await instance.endInputAndAwaitExit(10))
            .toEqual({ exited: false, code: null, signal: null });
        expect(signals).toEqual([]);
    });

    it('shouldNotReportACleanExitWhenThereWasNoProcess', async () => {
        // "There was no process" is not "the process finished writing".
        const instance = client(null);
        expect(await instance.endInputAndAwaitExit(1_000))
            .toEqual({ exited: false, code: null, signal: null });
    });

    it('shouldAnswerAtOnceForAProcessThatHadAlreadyLeft', async () => {
        // `exit` fired before anyone was listening. Waiting for it again would
        // burn the whole budget and then call a finished process "not seen
        // leaving" — an unclean verdict for a provider that flushed fine.
        const { proc, endedCount } = processDouble();
        (proc as unknown as { exitCode: number | null }).exitCode = 0;
        (proc as unknown as { signalCode: string | null }).signalCode = null;
        const instance = client(proc);

        const started = Date.now();
        expect(await instance.endInputAndAwaitExit(5_000)).toEqual({ exited: true, code: 0, signal: null });
        expect(Date.now() - started).toBeLessThan(1_000);
        // Nothing to end on a process that is gone.
        expect(endedCount()).toBe(0);
    });

    it('shouldReportASignalledExitAsSignalledRatherThanHidingIt', async () => {
        // It sends no signal, but something else may have. The caller needs to
        // see that, because it is never a flush.
        const { proc } = processDouble();
        const instance = client(proc);

        const settled = instance.endInputAndAwaitExit(1_000);
        proc.emit('exit', null, 'SIGTERM');

        expect(await settled).toEqual({ exited: true, code: null, signal: 'SIGTERM' });
    });
});


describe('endInputAndAwaitExit retry cleanup', () => {
    afterEach(() => vi.useRealTimers());
    it('removes only its own listener and deadline after a timeout', async () => {
        vi.useFakeTimers();
        const { proc } = processDouble();
        const other = () => {};
        proc.on('exit', other);
        const result = client(proc).endInputAndAwaitExit(10);
        await vi.advanceTimersByTimeAsync(10);
        expect(await result).toEqual({ exited: false, code: null, signal: null });
        expect(proc.listeners('exit')).toEqual([other]);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('cleans up when ending stdin throws', async () => {
        vi.useFakeTimers();
        const { proc } = processDouble();
        proc.stdin = { end: () => { throw new Error('closed pipe'); } };
        expect(await client(proc).endInputAndAwaitExit(1000)).toEqual({ exited: false, code: null, signal: null });
        expect(proc.listenerCount('exit')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('clears the deadline after synchronous exit from stdin.end', async () => {
        vi.useFakeTimers();
        const { proc } = processDouble();
        proc.stdin = { end: () => { proc.emit('exit', 0, null); } };
        expect(await client(proc).endInputAndAwaitExit(1000)).toEqual({ exited: true, code: 0, signal: null });
        expect(proc.listenerCount('exit')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
