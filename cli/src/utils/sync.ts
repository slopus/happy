import { createBackoff, type BackoffFunc } from "@/utils/time";

export type InvalidateSyncOptions = {
    backoff?: BackoffFunc;
    onError?: (error: unknown, failuresCount: number) => void;
};

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
        this._backoff = opts.backoff ?? createBackoff({
            onError: (e, failuresCount) => {
                this._lastFailureCount = failuresCount;
                this._onError?.(e, failuresCount);
            },
        });
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
                await this._command();
            });
        } catch (e) {
            // Always resolve pending awaiters even on failure; otherwise invalidateAndAwait() can hang forever.
            this._onError?.(e, this._lastFailureCount + 1);
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
