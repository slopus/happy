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
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
};

const NOT_SEEN = Object.freeze({ exited: false, code: null, signal: null });

export function createClaudeDrainProvider(deps: ClaudeDrainDeps): DrainProvider {
    const now = deps.now ?? (() => Date.now());
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    let frozen = false;

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
            await deps.activeTurn()?.interrupt();
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
