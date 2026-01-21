import { createBackoff } from "@/utils/time";

export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _pendings: (() => void)[] = [];
    private _onError?: (e: any) => void;
    private _onSuccess?: () => void;
    private _onRetry?: (info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => void;
    private _backoff!: ReturnType<typeof createBackoff>;

    constructor(
        command: () => Promise<void>,
        opts?: {
            onError?: (e: any) => void;
            onSuccess?: () => void;
            onRetry?: (info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => void;
        }
    ) {
        this._command = command;
        this._onError = opts?.onError;
        this._onSuccess = opts?.onSuccess;
        this._onRetry = opts?.onRetry;
        this._backoff = createBackoff({
            maxFailureCount: Number.POSITIVE_INFINITY,
            onError: (e) => console.warn(e),
            onRetry: (_e, failuresCount, nextDelayMs) => {
                this._onRetry?.({ failuresCount, nextDelayMs, nextRetryAt: Date.now() + nextDelayMs });
            }
        });
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
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

    async awaitQueue() {
        if (this._stopped || (!this._invalidated && this._pendings.length === 0)) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
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
        try {
            await this._backoff(async () => {
                if (this._stopped) {
                    return;
                }
                await this._command();
            });
            this._onSuccess?.();
        } catch (e) {
            // Non-retryable errors (e.g. auth/config) should not brick the sync queue.
            // We treat this as a "give up for now" and allow future invalidations to retry.
            this._onError?.(e);
            console.warn(e);
        }
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            this._invalidated = false;
            this._notifyPendings();
        }
    }
}

export class ValueSync<T> {
    private _latestValue: T | undefined;
    private _hasValue = false;
    private _processing = false;
    private _stopped = false;
    private _command: (value: T) => Promise<void>;
    private _pendings: (() => void)[] = [];

    constructor(command: (value: T) => Promise<void>) {
        this._command = command;
    }

    setValue(value: T) {
        if (this._stopped) {
            return;
        }
        this._latestValue = value;
        this._hasValue = true;
        if (!this._processing) {
            this._processing = true;
            this._doSync();
        }
    }

    async setValueAndAwait(value: T) {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.setValue(value);
        });
    }

    async awaitQueue() {
        if (this._stopped || (!this._processing && this._pendings.length === 0)) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
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
        while (this._hasValue && !this._stopped) {
            const value = this._latestValue!;
            this._hasValue = false;
            
            try {
                const backoffForever = createBackoff({ maxFailureCount: Number.POSITIVE_INFINITY, onError: (e) => console.warn(e) });
                await backoffForever(async () => {
                    if (this._stopped) {
                        return;
                    }
                    await this._command(value);
                });
            } catch (e) {
                // Non-retryable errors should stop this processing loop, but not deadlock awaiters.
                console.warn(e);
                break;
            }
            
            if (this._stopped) {
                this._notifyPendings();
                return;
            }
        }
        
        this._processing = false;
        this._notifyPendings();
    }
}
