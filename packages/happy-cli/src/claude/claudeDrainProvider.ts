import type { DrainProvider } from '@/sessionDrain/sessionDrain';
import type { ObservedSdkExit } from '@/managed/managedProviderExitObserver';

/**
 * The Claude side of the Windows standalone session drain (`SessionDrain`).
 *
 * Built on the pieces a managed run already uses to end without being killed:
 * the graceful stop ends the SDK's streaming input at a turn boundary, and the
 * per-generation exit observer reports what the SDK's own process did. A kill
 * or a cancellation is never reported as a clean exit.
 */
export type ClaudeDrainDeps = {
    /** The message loop is running and able to end its input. */
    ready: () => boolean;
    /** Stops admitting input for good, drops input not yet started, and denies pending permission prompts. */
    freezeInput: () => void;
    /** The SDK query of the turn in progress, if any. */
    activeTurn: () => { interrupt: () => Promise<unknown> } | null;
    /** Asks the loop to end the SDK's input at the next turn boundary (graceful stop). */
    requestEndInput: () => void;
    /** The current provider generation's exit observer, or `null` when no SDK process was ever started. */
    generation: () => { observed: () => ObservedSdkExit | null } | null;
    /** Settles when the launcher's message loop has ended. */
    loopFinished: Promise<void>;
    isLoopFinished: () => boolean;
    /** The generation's last result was an interrupted turn (`error_during_execution`). */
    lastTurnInterrupted: () => boolean;
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
};

const NOT_SEEN = Object.freeze({ exited: false, code: null, signal: null });

export function createClaudeDrainProvider(deps: ClaudeDrainDeps): DrainProvider {
    const now = deps.now ?? (() => Date.now());
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    let frozen = false;
    // Set once this drain interrupted a running turn through the SDK.
    let interrupted = false;

    /** What is known right now: `null` until the provider has been seen to leave. */
    const exitNow = (): { exited: boolean; code: number | null; signal: string | null } | null => {
        const generation = deps.generation();
        if (!generation) {
            // No SDK process was ever started, so there is nothing to exit —
            // but only once the loop is over and cannot start one any more.
            return deps.isLoopFinished() ? { exited: true, code: 0, signal: null } : null;
        }
        const observed = generation.observed();
        if (!observed) return null;
        /*
         * Claude Code reports an interrupted turn in its exit code when its input then ends: after
         * this drain's `interrupt()` the turn closes as `error_during_execution`, and the process
         * leaves on its own with code 1 — no signal, nothing killed it (reproduced with SDK 0.3.283 and 0.3.285).
         * That is the clean end of the turn the drain asked to stop, so it counts as exit 0; any
         * other code, a signal or a kill still does not.
         */
        if (interrupted && deps.lastTurnInterrupted() && observed.code === 1 && observed.signal === null && !observed.forced) {
            return { exited: true, code: 0, signal: null };
        }
        // A requested kill or cancellation is not a flush, whatever the exit code said.
        return { exited: true, code: observed.code, signal: observed.signal ?? (observed.forced ? 'forced' : null) };
    };

    return {
        freezeInputForShutdown() {
            if (frozen || !deps.ready()) return false;
            frozen = true;
            deps.freezeInput();
            return true;
        },
        async interruptTurn() {
            const turn = deps.activeTurn();
            if (!turn) return;
            interrupted = true;
            await turn.interrupt();
        },
        async endInputAndAwaitExit(budgetMs, signal) {
            deps.requestEndInput();
            const deadline = now() + budgetMs;
            for (;;) {
                if (signal?.aborted) return NOT_SEEN;
                const left = exitNow();
                if (left) return left;
                if (now() >= deadline) return NOT_SEEN;
                await wait(25);
            }
        },
        waitForOutputDrain: () => deps.loopFinished,
        // The loop's own teardown owns the SDK process; there is no separate reader to cancel.
        cancelOutputDrain() {},
        finishShutdownObservation() {},
    };
}
