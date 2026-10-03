const DAY_MS = 86400_000;
/** A failing pass (corrupt store, slow packing) is retried hourly, not on every heartbeat. */
const FAILURE_BACKOFF_MS = 3600_000;

/** Startup check and daily cleanup piggyback on the daemon heartbeat; no second interval. */
export class CheckpointRetentionSchedule {
    private lastSuccess: number | null = null;
    private lastFailure: number | null = null;
    private running: Promise<void> | null = null;
    private stopped = false;
    constructor(private readonly input: {
        collect(now: number): Promise<unknown>;
        isIdle(): boolean;
        now?: () => number;
        onError(error: unknown): void;
    }) {}

    tick(): Promise<void> {
        const now = this.input.now?.() ?? Date.now();
        if (this.stopped || this.running || !this.input.isIdle()
            || (this.lastSuccess !== null && now - this.lastSuccess < DAY_MS)
            || (this.lastFailure !== null && now - this.lastFailure < FAILURE_BACKOFF_MS)) return Promise.resolve();
        const work = Promise.resolve().then(() => this.input.collect(now)).then(
            () => { this.lastSuccess = now; this.lastFailure = null; },
            error => { this.lastFailure = now; this.input.onError(error); },
        );
        this.running = work;
        return work.finally(() => { if (this.running === work) this.running = null; });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        await this.running;
    }
}
