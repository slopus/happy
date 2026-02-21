import { backoff, BackoffGaveUpError, createBackoff } from "@/utils/time";

export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _wedged = false;
    private _command: () => Promise<void>;
    private _pendings: (() => void)[] = [];
    private _onError?: (error: unknown) => void;
    private _backoff: typeof backoff;

    constructor(command: () => Promise<void>, opts?: {
        onError?: (error: unknown) => void;
        maxRetries?: number;
    }) {
        this._command = command;
        this._onError = opts?.onError;
        this._backoff = opts?.maxRetries !== undefined
            ? createBackoff({ maxRetries: opts.maxRetries, onError: (e) => { console.warn(e); } })
            : backoff;
    }

    get isWedged() {
        return this._wedged;
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        // If previously wedged, reset and allow a fresh sync attempt
        if (this._wedged) {
            this._wedged = false;
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
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
        } catch (e) {
            if (e instanceof BackoffGaveUpError) {
                console.error(`[InvalidateSync] Gave up after ${e.attempts} retries:`, e.lastError);
                this._wedged = true;
                this._invalidated = false;
                this._notifyPendings();
                if (this._onError) {
                    this._onError(e);
                }
                return;
            }
            throw e;
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
