import type { DrainProvider } from '@/sessionDrain/sessionDrain';
import type { ObservedSdkExit } from '@/managed/managedProviderExitObserver';

/**
 * The ACP side (opencode, grok) of the Windows standalone session drain
 * (Desktop specs/windows-build-support W0-5f).
 *
 * An ACP agent ends on its own when its stdin closes: the running turn is
 * cancelled with `session/cancel`, the input is closed, and the backend reports
 * the agent process's own exit. A kill is never reported as a clean exit.
 */
export type AcpDrainDeps = {
    /** The runner loop is running a started agent. */
    ready: () => boolean;
    /** Stops admitting input for good and denies pending permission prompts. */
    freezeInput: () => void;
    /** The turn in progress, if any. */
    activeTurn: () => { interrupt: () => Promise<unknown> } | null;
    /** Closes the agent's stdin. */
    requestEndInput: () => void;
    /** An agent process was spawned. */
    processStarted: () => boolean;
    /** The agent process's exit, or `null` while it has not been seen to leave. */
    processExit: () => ObservedSdkExit | null;
    /** Settles after the runner loop's last write. */
    loopFinished: Promise<void>;
    isLoopFinished: () => boolean;
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
};

const NOT_SEEN = Object.freeze({ exited: false, code: null, signal: null });

export function createAcpDrainProvider(deps: AcpDrainDeps): DrainProvider {
    const now = deps.now ?? (() => Date.now());
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    let frozen = false;

    const exitNow = (): { exited: boolean; code: number | null; signal: string | null } | null => {
        if (!deps.processStarted()) {
            // Nothing was spawned, so nothing can exit — but only once the loop
            // is over and cannot spawn one any more.
            return deps.isLoopFinished() ? { exited: true, code: 0, signal: null } : null;
        }
        const observed = deps.processExit();
        if (!observed) return null;
        // A requested kill is not a flush, whatever the exit code said.
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
        // The runner's own teardown owns the agent process; there is no separate reader to cancel.
        cancelOutputDrain() {},
        finishShutdownObservation() {},
    };
}
