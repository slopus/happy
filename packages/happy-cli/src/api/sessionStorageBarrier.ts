export type StorageConfirmation = { stored: true; revision: number } | {
    stored: false;
    reason: 'unconfirmed-write' | 'unsupported' | 'deadline' | 'aborted' | 'disconnected' | 'closed' | 'sync-failed';
};
type Failure = Extract<StorageConfirmation, { stored: false }>['reason'];

/** Tracks writes, not socket idleness. The caller must quiesce producers before waiting. */
export class SessionStorageBarrier {
    private pending = 0;
    private retainedBytes = 0;
    private capacityWaiters = 0;
    private revision = 0;
    private currentProof: StorageConfirmation | null = null;
    isCurrent(proof: StorageConfirmation): boolean {
        return proof === this.currentProof && proof.stored && proof.revision === this.revision && this.pending === 0 && this.failure === null;
    }
    private failure: Failure | null = null;
    private readonly waiters = new Set<(interruption?: Failure) => void>();

    track(bytes: number = 0): (confirmed: boolean) => void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid storage byte charge');
        this.retainedBytes += bytes;
        this.revision++;
        this.pending++;
        let settled = false;
        return confirmed => {
            if (settled) return;
            settled = true;
            this.pending--;
            this.retainedBytes -= bytes;
            if (!confirmed) this.failure ??= 'unconfirmed-write';
            this.notify();
        };
    }
    fail(reason: Failure) { this.failure ??= reason; this.notify(); }
    interrupt(reason: Failure) { for (const waiter of [...this.waiters]) waiter(reason); }
    private notify() { for (const waiter of [...this.waiters]) waiter(); }

    waitForCapacity(maxBytes: number, maxWrites: number, signal?: AbortSignal): Promise<void> {
        if (![maxBytes, maxWrites].every(value => Number.isSafeInteger(value) && value > 0)) return Promise.reject(new Error('Invalid storage high water mark'));
        if (this.capacityWaiters >= 8) return Promise.reject(new Error('Too many storage capacity waiters'));
        this.capacityWaiters++;
        return new Promise<void>((resolve, reject) => {
            let finished = false;
            const check = (interruption?: Failure) => {
                if (finished) return;
                const reason = signal?.aborted ? 'aborted' : (interruption === 'closed' ? 'closed' : null);
                if (!reason && (this.retainedBytes >= maxBytes || this.pending >= maxWrites)) return;
                finished = true; this.capacityWaiters--;
                this.waiters.delete(check); signal?.removeEventListener('abort', onAbort);
                if (reason) reject(new Error(`Storage capacity unavailable: ${reason}`)); else resolve();
            };
            const onAbort = () => check('aborted');
            this.waiters.add(check); signal?.addEventListener('abort', onAbort, { once: true });
            check();
        });
    }

    wait(budgetMs: number, signal?: AbortSignal): Promise<StorageConfirmation> {
        if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 30_000) throw new Error('Invalid storage confirmation budget');
        const deadline = performance.now() + budgetMs;
        return new Promise(resolve => {
            let finished = false;
            const check = (interruption?: Failure) => {
                if (finished) return;
                const reason = signal?.aborted ? 'aborted' : performance.now() >= deadline ? 'deadline' : interruption ?? this.failure;
                if (!reason && this.pending !== 0) return;
                finished = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', aborted);
                this.waiters.delete(check);
                if (reason) resolve({ stored: false, reason });
                else { this.currentProof = Object.freeze({ stored: true, revision: this.revision }); resolve(this.currentProof); }
            };
            const aborted = () => check('aborted');
            const timer = setTimeout(() => check('deadline'), budgetMs);
            timer.unref?.();
            this.waiters.add(check);
            signal?.addEventListener('abort', aborted, { once: true });
            check();
        });
    }
}
