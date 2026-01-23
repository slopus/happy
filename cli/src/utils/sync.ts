import { createBackoff, type BackoffFunc } from "@/utils/time";

export type InvalidateSyncOptions = {
    backoff?: BackoffFunc;
    /**
     * Called whenever an attempted sync fails.
     *
     * Notes:
     * - `failuresCount` counts the number of failed attempts for the current sync run (1-based).
     * - With the default backoff, this is called on each retry attempt, and once more when the run
     *   ultimately fails (because the final thrown error does not trigger the backoff's `onError`).
     */
    onError?: (error: unknown, failuresCount: number) => void;
};

/**
 * Coalescing invalidation runner.
 *
 * Behavior:
 * - `invalidate()` schedules a run of `command()` if one isn't already in progress.
 * - If `invalidate()` is called while a run is in-flight, it queues exactly one additional run
 *   after the current run completes (coalescing repeated invalidations).
 * - `invalidateAndAwait()` resolves when the current (and any queued) run finishes.
 *
 * Failure semantics:
 * - `command()` is executed via a bounded backoff (default: up to 8 attempts).
 * - `invalidateAndAwait()` always resolves even if `command()` ultimately fails, so callers
 *   don't hang forever (e.g., startup/shutdown flows).
 */
export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _backoff: BackoffFunc;
    private _onError?: (error: unknown, failuresCount: number) => void;
    private _lastFailureCount = 0;
    private _pendings: (() => void)[] = [];

    constructor(command: () => Promise<void>, opts: InvalidateSyncOptions = {}) {
        this._command = command;
        this._onError = opts.onError;
        this._backoff = opts.backoff ?? createBackoff();
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            void this._doSync();
        } else {
            if (!this._invalidatedDouble) {
                this._invalidatedDouble = true;
            }
        }
    }

    async invalidateAndAwait() {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.invalidate();
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }


    private _doSync = async () => {
        this._lastFailureCount = 0;
        try {
            await this._backoff(async () => {
                if (this._stopped) {
                    return;
                }
                try {
                    await this._command();
                } catch (e) {
                    this._lastFailureCount++;
                    this._onError?.(e, this._lastFailureCount);
                    throw e;
                }
            });
        } catch (e) {
            // Always resolve pending awaiters even on failure; otherwise invalidateAndAwait() can hang forever.
            // Note: `_onError` is called on every failed attempt inside the callback above, even with custom backoffs.
            // If the backoff throws before any attempt runs, report a single failure.
            if (this._lastFailureCount === 0) {
                this._onError?.(e, 1);
            }
        }
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            void this._doSync();
        } else {
            this._invalidated = false;
            this._notifyPendings();
        }
    }
}
