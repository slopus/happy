import type { CodexRuntimeProducerGate } from './codexRuntimeProducerGate';
import type { StorageConfirmation } from '../api/sessionStorageBarrier';
export type DrainProvider = {
    freezeInputForShutdown(): boolean;
    interruptTurn(): Promise<void>;
    endInputAndAwaitExit(budgetMs: number, signal?: AbortSignal): Promise<{ exited: boolean; code: number | null; signal: string | null }>;
    waitForOutputDrain(): Promise<void>;
    cancelOutputDrain(): void;
    finishShutdownObservation(): void;
};
type Storage = {
    tracksShutdownStorage: boolean;
    flushForShutdown(budgetMs: number, signal?: AbortSignal): Promise<StorageConfirmation>;
    isStorageConfirmationCurrent(proof: StorageConfirmation): boolean;
};
export type CodexDrainReceipt = Readonly<{
    launchId: string; status: 'provider-drained' | 'blocked'; reason: string | null;
    ownership: 'none' | 'held' | 'unknown';
    providerExited: boolean; outputDrained: boolean; stored: boolean;
    exitObserved: boolean; exitCode: number | null; exitSignal: string | null;
    runtimeExited: false; jobEmpty: false;
}>;
class DrainFailure extends Error {}
/** Reply delivery starts only after storage proof; it needs its own bounded window. */
const DRAIN_RELEASE_WINDOW_MS = 10_000;

/** Runtime-side provider/storage coordination only. Never a daemon completion or Job receipt. */
export class CodexSessionDrain {
    private readonly issuedReceipts = new WeakSet<CodexDrainReceipt>();
    private operation: Promise<CodexDrainReceipt> | null = null;
    private receipt: CodexDrainReceipt | null = null;
    private proof: StorageConfirmation | null = null;
    private releaseTimer: ReturnType<typeof setTimeout> | null = null;
    constructor(readonly launchId: string, private readonly provider: DrainProvider, private readonly storage: Storage,
        private readonly quiesceProducers: (signal: AbortSignal) => Promise<void>, private readonly runtime?: CodexRuntimeProducerGate) {
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(launchId)) throw new Error('Invalid launch identity');
    }

    /** The first acquired freeze owns budget/cancellation. A refusal without mutation can be retried. */
    drain(budgetMs: number, signal?: AbortSignal, releaseBudgetMs = DRAIN_RELEASE_WINDOW_MS): Promise<CodexDrainReceipt> {
        if (this.operation) return this.operation;
        if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 30000) throw new Error('Invalid drain budget');
        if (!Number.isFinite(releaseBudgetMs) || releaseBudgetMs <= 0 || releaseBudgetMs > DRAIN_RELEASE_WINDOW_MS) throw new Error('Invalid release budget');
        const deadline = performance.now() + budgetMs;
        // Reserve ownership before synchronous freeze callbacks can reenter drain.
        let resolveOperation!: (receipt: CodexDrainReceipt) => void;
        let rejectOperation!: (error: unknown) => void;
        const owned = new Promise<CodexDrainReceipt>((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
        this.operation = owned;
        let frozen = false;
        let ownership: CodexDrainReceipt['ownership'] = 'none';
        let initialFailure: string | null = null;
        try {
            if (signal?.aborted) initialFailure = 'aborted';
            else if (!this.storage.tracksShutdownStorage) initialFailure = 'unsupported';
            else {
                initialFailure = this.runtime?.blocker() ?? null;
                if (!initialFailure) {
                    ownership = 'unknown'; // A throwing provider may already have mutated.
                    frozen = this.provider.freezeInputForShutdown();
                    ownership = frozen ? 'held' : 'none';
                    if (!frozen) initialFailure = 'unsupported';
                    else this.runtime?.freeze();
                }
            }
        } catch {
            initialFailure = 'freeze-failed';
            if (ownership === 'unknown' && this.runtime) {
                // The provider may have committed before throwing. Seal runtime
                // admission too; a partial runtime freeze still owns its hold.
                try { this.runtime.freeze(); } catch { /* Preserve the original failure. */ }
                if (this.runtime.isFrozen()) this.runtime.blockShutdownStorage();
            }
        }
        const operation = Promise.resolve().then(async () => {
            const controller = new AbortController();
            const abort = () => controller.abort(new DrainFailure('aborted'));
            const timer = setTimeout(() => controller.abort(new DrainFailure('deadline')), Math.max(0, deadline - performance.now()));
            timer.unref?.();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const remaining = () => {
                if (controller.signal.aborted) throw controller.signal.reason;
                const ms = deadline - performance.now();
                if (ms <= 0) throw new DrainFailure('deadline');
                return ms;
            };
            let onAbort!: () => void;
            const cancelled = new Promise<never>((_, reject) => {
                onAbort = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            void cancelled.catch(() => {});
            // Every async stage must settle or lose observation to the same deadline.
            const step = async <T>(work: Promise<T>): Promise<T> => {
                // Attach before checking cancellation so already-started work cannot reject unhandled.
                const pending = Promise.race([work, cancelled]);
                if (controller.signal.aborted) onAbort();
                const value = await pending; remaining(); return value;
            };
            let providerExited = false, outputDrained = false, stored = false;
            let exitObserved = false, exitCode: number | null = null, exitSignal: string | null = null;
            let reason: string | null = initialFailure;
            try {
                if (reason) throw new DrainFailure(reason);
                remaining();
                const producers = step(Promise.all([
                    Promise.resolve().then(() => this.quiesceProducers(controller.signal)),
                    Promise.resolve().then(() => this.runtime?.quiesce(controller.signal)),
                ]));
                // Attach immediately: producer refusal must not become an unhandled rejection.
                void producers.catch(() => {});
                await step(this.provider.interruptTurn());
                const exit = step(this.provider.endInputAndAwaitExit(remaining(), controller.signal).then(left => {
                    exitObserved = left.exited; exitCode = left.code; exitSignal = left.signal;
                    providerExited = left.exited && left.code === 0 && left.signal === null;
                    remaining();
                    return left;
                }));
                const output = step(this.provider.waitForOutputDrain().then(() => { outputDrained = true; }));
                await step(Promise.all([exit, output, producers]));
                if (!providerExited) throw new DrainFailure(exitObserved ? 'provider-exit-unclean' : 'provider-exit-unconfirmed');
                const proof = await step(this.storage.flushForShutdown(remaining(), controller.signal));
                if (!proof.stored) throw new DrainFailure(proof.reason);
                if (!this.storage.isStorageConfirmationCurrent(proof)) throw new DrainFailure('stale-storage-proof');
                remaining(); this.proof = proof; stored = true;
            } catch (error) {
                reason = error instanceof DrainFailure ? error.message : 'drain-failed';
                controller.abort(error);
                // Unknown provider ownership retains observation; do not guess that releasing it is safe.
                if (frozen) { try { this.provider.cancelOutputDrain(); } catch { /* Never replace a failed verdict with observer cleanup failure. */ } }
            } finally {
                clearTimeout(timer); signal?.removeEventListener('abort', abort);
                controller.signal.removeEventListener('abort', onAbort);
                if (frozen) {
                    try { this.provider.finishShutdownObservation(); }
                    catch {
                        // An observer cleanup failure cannot turn a drain into a rejection
                        // or leave an already captured proof eligible for a clean receipt.
                        reason ??= 'observation-cleanup-failed';
                        stored = false;
                        this.proof = null;
                    }
                }
            }
            // Observation cleanup can invoke callbacks. Do not release runtime
            // ownership using a proof that became stale in that final step.
            if (stored && this.proof) {
                try {
                    if (!this.storage.isStorageConfirmationCurrent(this.proof)) {
                        reason = 'stale-storage-proof'; stored = false; this.proof = null;
                    }
                } catch {
                    reason = 'drain-failed'; stored = false; this.proof = null;
                }
            }
            const receipt: CodexDrainReceipt = Object.freeze({ launchId: this.launchId, status: stored ? 'provider-drained' : 'blocked',
                ownership, reason, providerExited, outputDrained, stored, exitObserved, exitCode, exitSignal, runtimeExited: false, jobEmpty: false });
            this.issuedReceipts.add(receipt);
            if (ownership !== 'none') this.receipt = receipt;
            if (frozen && !stored) this.runtime?.blockShutdownStorage();
            if (stored && this.runtime) {
                // A reply that is never delivered must not hold the loop forever.
                this.releaseTimer = setTimeout(() => {
                    this.releaseTimer = null;
                    this.runtime?.blockShutdownStorage();
                }, releaseBudgetMs);
                this.releaseTimer.unref?.();
            }
            return receipt;
        });
        // A throwing freeze may have mutated its provider. Do not assume that retry is safe.
        if (ownership === 'none') this.operation = null;
        void operation.then(resolveOperation, rejectOperation);
        return owned;
    }

    isCurrent(receipt: CodexDrainReceipt): boolean {
        return receipt === this.receipt && receipt.stored && this.proof !== null && !this.runtime?.isShutdownBlocked()
            && this.storage.isStorageConfirmationCurrent(this.proof);
    }

    /** The caller owns reply delivery and releases the runtime only after accepting this receipt. */
    releaseRuntime(receipt: CodexDrainReceipt): void {
        let current = false;
        try { current = this.isCurrent(receipt); } catch { /* Failed proof recheck is blocked, not releasable. */ }
        if (!this.runtime || !current) {
            if (this.runtime && receipt === this.receipt) this.abandonRuntime(receipt);
            throw new Error('Drain receipt is not current');
        }
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
        this.runtime.confirmShutdownStorage();
    }

    /** The reply failed; keep resources owned and publish a blocked decision. */
    abandonRuntime(receipt: CodexDrainReceipt): void {
        if (!this.runtime || receipt !== this.receipt) throw new Error('Drain receipt is not current');
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
        this.runtime.blockShutdownStorage();
    }

    /** Confirmed authorizes cleanup, not runtime/Job exit. A runtime gate is required to enforce its hold. */
    outcome(receipt: CodexDrainReceipt): Promise<'none' | 'confirmed' | 'blocked'> {
        if (!this.issuedReceipts.has(receipt)) return Promise.reject(new Error('Drain receipt was not issued by this coordinator'));
        if (receipt.ownership === 'none') return Promise.resolve('none');
        if (receipt.ownership === 'unknown' || !receipt.stored) return Promise.resolve('blocked');
        if (!this.runtime) return Promise.reject(new Error('Runtime gate unavailable'));
        return this.runtime.waitForShutdownDecision();
    }
}
