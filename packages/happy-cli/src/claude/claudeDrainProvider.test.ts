import { describe, expect, it, vi } from 'vitest';
import { createClaudeDrainProvider, type ClaudeDrainDeps } from './claudeDrainProvider';
import type { ObservedSdkExit } from '@/managed/managedProviderExitObserver';

function fixture(overrides: Partial<ClaudeDrainDeps> = {}) {
    let observed: ObservedSdkExit | null = null;
    let generationStarted = true;
    let loopDone = false;
    let finishLoop!: () => void;
    const loopFinished = new Promise<void>((resolve) => { finishLoop = () => { loopDone = true; resolve(); }; });
    let clock = 0;
    const deps: ClaudeDrainDeps = {
        ready: () => true,
        freezeInput: vi.fn(),
        activeTurn: () => null,
        requestEndInput: vi.fn(),
        generation: () => (generationStarted ? { observed: () => observed } : null),
        loopFinished,
        isLoopFinished: () => loopDone,
        lastTurnInterrupted: () => false,
        now: () => clock,
        wait: async (ms: number) => { clock += ms; },
        ...overrides,
    };
    return {
        provider: createClaudeDrainProvider(deps),
        deps,
        exit: (value: ObservedSdkExit) => { observed = value; },
        noGeneration: () => { generationStarted = false; },
        finishLoop,
    };
}

describe('Claude drain provider', () => {
    it('refuses to freeze a runtime that is not ready, and freezes input only once', () => {
        expect(fixture({ ready: () => false }).provider.freezeInputForShutdown()).toBe(false);
        const f = fixture();
        expect(f.provider.freezeInputForShutdown()).toBe(true);
        expect(f.deps.freezeInput).toHaveBeenCalledTimes(1);
        expect(f.provider.freezeInputForShutdown()).toBe(false);
    });

    it('interrupts a running turn without killing the provider, and does nothing when idle', async () => {
        const interrupt = vi.fn(async () => undefined);
        await fixture({ activeTurn: () => ({ interrupt }) }).provider.interruptTurn();
        expect(interrupt).toHaveBeenCalledTimes(1);
        await expect(fixture().provider.interruptTurn()).resolves.toBeUndefined();
    });

    it('ends the SDK input and reports the exit the observer saw', async () => {
        const f = fixture();
        f.provider.freezeInputForShutdown();
        const left = f.provider.endInputAndAwaitExit(5_000);
        f.exit({ code: 0, signal: null, forced: false });
        f.finishLoop();
        await expect(left).resolves.toEqual({ exited: true, code: 0, signal: null });
        expect(f.deps.requestEndInput).toHaveBeenCalledTimes(1);
    });

    it('reports a non-zero or killed exit as it was, never as clean', async () => {
        const failed = fixture();
        failed.exit({ code: 1, signal: null, forced: false }); failed.finishLoop();
        await expect(failed.provider.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 1, signal: null });
        const killed = fixture();
        killed.exit({ code: 0, signal: null, forced: true }); killed.finishLoop();
        await expect(killed.provider.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 0, signal: 'forced' });
    });

    it('counts a session that never started a provider as exited once its loop is over', async () => {
        const f = fixture(); f.noGeneration(); f.finishLoop();
        await expect(f.provider.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 0, signal: null });
    });

    it('does not claim an exit it did not see before the budget ran out, or after an abort', async () => {
        const f = fixture();
        await expect(f.provider.endInputAndAwaitExit(1_000)).resolves.toEqual({ exited: false, code: null, signal: null });
        const aborted = fixture();
        const controller = new AbortController(); controller.abort();
        await expect(aborted.provider.endInputAndAwaitExit(5_000, controller.signal)).resolves.toEqual({ exited: false, code: null, signal: null });
    });

    it('waits for the launcher loop to finish before output counts as drained', async () => {
        const f = fixture();
        let drained = false;
        const done = f.provider.waitForOutputDrain().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        f.finishLoop();
        await done;
        expect(drained).toBe(true);
    });

    it('counts the exit 1 Claude Code gives after the drain interrupted its turn as clean, and nothing looser', async () => {
        // Claude Code reports an interrupted turn (error_during_execution) in its exit code when its
        // input then ends: code 1, no signal, not killed. Reproduced with SDK 0.3.283 and 0.3.285.
        const interrupt = vi.fn(async () => undefined);
        const drained = (overrides: Partial<ClaudeDrainDeps>, observed: { code: number; signal: string | null; forced: boolean }) => {
            const f = fixture({ activeTurn: () => ({ interrupt }), lastTurnInterrupted: () => true, ...overrides });
            f.exit(observed); f.finishLoop();
            return f.provider;
        };
        const clean = drained({}, { code: 1, signal: null, forced: false });
        await clean.interruptTurn();
        await expect(clean.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 0, signal: null });
        // Not interrupted by this drain: the exit code stands.
        await expect(drained({}, { code: 1, signal: null, forced: false }).endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 1, signal: null });
        // The last result was not an interrupt.
        const other = drained({ lastTurnInterrupted: () => false }, { code: 1, signal: null, forced: false });
        await other.interruptTurn();
        await expect(other.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 1, signal: null });
        // A kill or another code is never clean.
        const killed = drained({}, { code: 1, signal: null, forced: true });
        await killed.interruptTurn();
        await expect(killed.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 1, signal: 'forced' });
        const crashed = drained({}, { code: 3, signal: null, forced: false });
        await crashed.interruptTurn();
        await expect(crashed.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 3, signal: null });
    });
});

