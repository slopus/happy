import { AsyncLock } from '@/utils/lock';
import type { SessionStorageBarrier } from './sessionStorageBarrier';
export class SessionStateWriteRefused extends Error {}

type Write = { apply: () => Promise<boolean>; confirm: (confirmed: boolean) => void; settled: boolean; attempted: boolean };

/** Holds later state transforms until every predecessor is stored; only failed writes replay. */
export class SessionStateWrites {
    private readonly lock = new AsyncLock();
    private readonly pending: Write[] = [];
    constructor(private readonly barrier: SessionStorageBarrier | null, private readonly warn: () => void, private readonly canWrite: () => boolean = () => true, private readonly onBlocked: () => void = () => {}) {}
    enqueue(apply: () => Promise<boolean>) {
        const write: Write = { apply, confirm: this.barrier?.track() ?? (() => {}), settled: false, attempted: false };
        if (this.barrier) this.pending.push(write);
        void this.lock.inLock(async () => {
            if (write.attempted || (this.barrier && this.pending[0] !== write)) return;
            write.settled = await this.tryWrite(write);
            this.settlePrefix();
            if (!write.settled) this.blocked();
        });
    }
    retry(active: () => boolean) {
        void this.lock.inLock(async () => {
            if (!active()) return;
            const replay = [...this.pending];
            // Successors have not run yet; preserve FIFO when retrying the failed head.
            for (const write of replay) {
                if (!active()) break;
                write.settled = await this.tryWrite(write);
                if (!write.settled) { this.blocked(); break; }
                this.settlePrefix();
            }
        });
    }
    private async tryWrite(write: Write): Promise<boolean> {
        write.attempted = true;
        for (let attempt = 0; attempt < (this.barrier ? 3 : 1); attempt++) {
            if (!this.canWrite()) return false;
            try { if (await write.apply()) { write.confirm(true); return true; } }
            catch (error) {
                if (this.barrier && error instanceof SessionStateWriteRefused) {
                    // Drop only the non-retryable transform, never its failure evidence.
                    write.confirm(false); this.warn(); return true;
                }
                if (!this.barrier) { this.warn(); return false; }
            }
        }
        if (this.barrier) this.warn();
        return false;
    }
    private blocked() {
        this.barrier?.interrupt('unconfirmed-write');
        this.onBlocked();
    }
    private settlePrefix() {
        while (this.pending[0]?.settled) this.pending.shift();
    }
}
