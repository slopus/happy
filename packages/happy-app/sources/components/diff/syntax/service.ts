import { LruCache } from '../engine/lru';
import { SYNTAX_REVEAL_MS, SyntaxWorkerUnavailableError, withinSyntaxLimits, type SyntaxInput, type SyntaxResult, type SyntaxWorker } from './protocol';

export type SyntaxOutcome = {
    status: SyntaxResult['status'] | 'timeout' | 'cancelled' | 'error';
    result?: SyntaxResult;
};
export interface SyntaxRequest {
    promise: Promise<SyntaxOutcome>;
    cancel(): void;
    setPriority(priority: number): void;
}
type Consumer = {
    priority: number;
    created: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (outcome: SyntaxOutcome) => void;
};
type Job = {
    key: string;
    input: SyntaxInput;
    created: number;
    started?: number;
    consumers: Set<Consumer>;
};

/** Cache keys include exact content + language; no path/hash collisions or theme. */
export function syntaxKey(input: SyntaxInput): string {
    return JSON.stringify([1, input.language, input.lines]);
}

/**
 * One bounded queue and the same LRU implementation as base diff documents.
 * Deadlines include queue time. Timed-out native calls retain the worker slot
 * until they really finish: Worklets has no public terminate API, and spawning
 * replacements would accumulate runaway threads. The UI never waits for them.
 */
export class SyntaxService {
    private readonly cache = new LruCache<SyntaxOutcome>(512, 4 * 1024 * 1024);
    private readonly jobs = new Map<string, Job>();
    private active: Job | undefined;
    private drainTimer: ReturnType<typeof setTimeout> | undefined;
    private unavailable = false;
    private counters = { hits: 0, completed: 0, timeouts: 0, cancelled: 0, errors: 0, computeMs: 0 };

    constructor(
        private readonly worker: SyntaxWorker,
        private readonly log: (event: string) => void = (event) => console.log(`[perf] diff syntax ${event}`),
        private readonly now: () => number = () => performance.now(),
    ) {}

    peek(key: string): SyntaxOutcome | undefined { return this.cache.get(key); }
    /** Dev benchmark: clear results without allocating another native runtime. */
    clearCache(): void { this.cache.clear(); }
    recordCacheUse(count: number): void {
        if (!count) return;
        this.counters.hits += count;
    }
    getStats() { return { ...this.counters, queued: this.jobs.size - (this.active && this.jobs.has(this.active.key) ? 1 : 0), running: Boolean(this.active) }; }

    request(input: SyntaxInput, priority = 1, key = syntaxKey(input)): SyntaxRequest {
        const cached = this.cache.get(key);
        if (cached) {
            this.counters.hits++;
            return { promise: Promise.resolve(cached), cancel() {}, setPriority() {} };
        }
        if (this.unavailable) {
            return { promise: Promise.resolve({ status: 'error' }), cancel() {}, setPriority() {} };
        }
        if (!withinSyntaxLimits(input)) {
            const outcome: SyntaxOutcome = { status: 'limited' };
            this.remember(key, outcome);
            return { promise: Promise.resolve(outcome), cancel() {}, setPriority() {} };
        }
        let job = this.jobs.get(key);
        if (!job) {
            // Backpressure is transient; unlike a pathological input it must
            // not poison the cache when the user later actually reads it.
            if (this.jobs.size >= 64) {
                return { promise: Promise.resolve({ status: 'cancelled' }), cancel() {}, setPriority() {} };
            }
            job = { key, input, created: this.now(), consumers: new Set() };
            this.jobs.set(key, job);
        }
        const target = job;
        let consumer!: Consumer;
        const promise = new Promise<SyntaxOutcome>((resolve) => {
            consumer = {
                priority, resolve, created: this.now(),
                timer: setTimeout(() => this.release(target, consumer, 'timeout'), SYNTAX_REVEAL_MS),
            };
            target.consumers.add(consumer);
        });
        this.scheduleDrain();
        return {
            promise,
            setPriority: (next) => { consumer.priority = next; },
            cancel: () => this.release(target, consumer, 'cancelled'),
        };
    }

    private release(job: Job, consumer: Consumer, status: 'timeout' | 'cancelled') {
        if (!job.consumers.delete(consumer)) return;
        clearTimeout(consumer.timer);
        consumer.resolve({ status });
        if (status === 'timeout') {
            this.counters.timeouts++;
            this.log(`status=timeout wait=${(this.now() - consumer.created).toFixed(1)}ms started=${job.started !== undefined}`);
        } else this.counters.cancelled++;
        // An expired queue slot says nothing about the input's complexity.
        // Never cache it; a future reader gets a fresh deadline and request.
        if (!job.consumers.size && job !== this.active) this.jobs.delete(job.key);
    }

    private remember(key: string, outcome: SyntaxOutcome) {
        const runs = outcome.result?.runs.reduce((n, line) => n + line.length, 0) ?? 0;
        this.cache.set(key, outcome, key.length * 2 + runs * 48);
    }

    private settle(job: Job, outcome: SyntaxOutcome) {
        this.jobs.delete(job.key);
        this.remember(job.key, outcome);
        const late = job.consumers.size === 0;
        this.log(`status=${late ? 'late-' : ''}${outcome.status} queue=${((job.started ?? this.now()) - job.created).toFixed(1)}ms compute=${(outcome.result?.computeMs ?? 0).toFixed(1)}ms total=${(this.now() - job.created).toFixed(1)}ms lines=${job.input.lines.length}`);
        for (const consumer of job.consumers) {
            if (this.now() - consumer.created >= SYNTAX_REVEAL_MS) this.release(job, consumer, 'timeout');
            else { clearTimeout(consumer.timer); consumer.resolve(outcome); }
        }
        job.consumers.clear();
        this.scheduleDrain();
    }

    private scheduleDrain() {
        if (this.active || this.drainTimer !== undefined) return;
        // Enqueue only from committed effects, coalescing a mount's requests
        // before choosing priority. This timer does NOT perform tokenization.
        this.drainTimer = setTimeout(() => {
            this.drainTimer = undefined;
            this.drain();
        }, 0);
    }

    private drain() {
        if (this.active) return;
        let next: Job | undefined;
        let best = -Infinity;
        for (const job of this.jobs.values()) {
            const priority = Math.max(...Array.from(job.consumers, (consumer) => consumer.priority));
            if (priority > best) { next = job; best = priority; }
        }
        if (!next) return;
        const job = next;
        if (this.unavailable) {
            this.jobs.delete(job.key);
            for (const consumer of job.consumers) {
                clearTimeout(consumer.timer);
                consumer.resolve({ status: 'error' });
            }
            job.consumers.clear();
            this.scheduleDrain();
            return;
        }
        job.started = this.now();
        this.active = job;
        let work: Promise<SyntaxResult>;
        try { work = this.worker.run(job.input); }
        catch { work = Promise.reject(new SyntaxWorkerUnavailableError('Diff syntax worker unavailable')); }
        work.then((result) => {
            this.counters.completed++;
            this.counters.computeMs += result.computeMs;
            const outcome: SyntaxOutcome = { status: result.status, result };
            this.settle(job, outcome);
        }, (error: unknown) => {
            this.counters.errors++;
            if (error instanceof SyntaxWorkerUnavailableError) {
                this.unavailable = true;
                this.jobs.delete(job.key);
                for (const consumer of job.consumers) {
                    clearTimeout(consumer.timer);
                    consumer.resolve({ status: 'error' });
                }
                job.consumers.clear();
                this.log('status=unavailable');
            } else this.settle(job, { status: 'error' });
        }).finally(() => {
            this.active = undefined;
            this.scheduleDrain();
        });
    }
}