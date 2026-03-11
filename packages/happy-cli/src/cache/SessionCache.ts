// packages/happy-cli/src/cache/SessionCache.ts

export interface SessionCacheRuntimeStats {
    totalRequests: number;
    coldLoadCount: number;
    freshHitCount: number;
    staleHitCount: number;
    waitForRefreshCount: number;
    waitForExistingRefreshHitCount: number;
    refreshCount: number;
    foregroundRefreshCount: number;
    backgroundRefreshCount: number;
    refreshSuccessCount: number;
    refreshErrorCount: number;
    inFlightJoinCount: number;
    invalidateCount: number;
    lastRequestAt?: string;
    lastRequestWaitForRefresh?: boolean;
    lastDecision?: 'cold-load' | 'fresh-hit' | 'stale-hit' | 'wait-for-refresh' | 'wait-for-existing-refresh';
    lastRefreshStartedAt?: string;
    lastRefreshFinishedAt?: string;
    lastRefreshDurationMs?: number;
    lastRefreshMode?: 'cold-start' | 'foreground' | 'background';
    lastInvalidateAt?: string;
}

export interface SessionCacheOptions<T> {
    loader: () => Promise<T[]>;
    staleTTL?: number;
    matchFn: (session: T, query: string) => boolean;
    onStatsChanged?: (stats: SessionCacheRuntimeStats) => void | Promise<void>;
}

type RefreshMode = 'cold-start' | 'foreground' | 'background';

type RequestDecision = NonNullable<SessionCacheRuntimeStats['lastDecision']>;

export class SessionCache<T> {
    private data: T[] | null = null;
    private loadingPromise: Promise<T[]> | null = null;
    private lastRefreshTime: number = 0;
    private staleTTL: number;
    private loader: () => Promise<T[]>;
    private matchFn: (session: T, query: string) => boolean;
    private onStatsChanged?: (stats: SessionCacheRuntimeStats) => void | Promise<void>;
    private stats: SessionCacheRuntimeStats = {
        totalRequests: 0,
        coldLoadCount: 0,
        freshHitCount: 0,
        staleHitCount: 0,
        waitForRefreshCount: 0,
        waitForExistingRefreshHitCount: 0,
        refreshCount: 0,
        foregroundRefreshCount: 0,
        backgroundRefreshCount: 0,
        refreshSuccessCount: 0,
        refreshErrorCount: 0,
        inFlightJoinCount: 0,
        invalidateCount: 0,
    };
    private emitQueued = false;

    constructor(options: SessionCacheOptions<T>) {
        this.loader = options.loader;
        this.staleTTL = options.staleTTL ?? 30_000;
        this.matchFn = options.matchFn;
        this.onStatsChanged = options.onStatsChanged;
    }

    async list(params: {
        offset: number;
        limit: number;
        query?: string;
        waitForRefresh?: boolean;
    }): Promise<{ sessions: T[]; total: number; fromCache: boolean }> {
        const { offset, limit, query, waitForRefresh } = params;
        let requestDecision: RequestDecision | null = null;
        let waitedForExistingRefresh = false;

        const setRequestDecision = (decision: RequestDecision): void => {
            if (requestDecision) {
                return;
            }
            requestDecision = decision;
            this.stats.lastDecision = decision;
        };

        this.stats.totalRequests++;
        this.stats.lastRequestAt = new Date().toISOString();
        this.stats.lastRequestWaitForRefresh = waitForRefresh === true;
        if (waitForRefresh) {
            this.stats.waitForRefreshCount++;
        }

        try {
            if (waitForRefresh && this.loadingPromise) {
                waitedForExistingRefresh = true;
                this.stats.inFlightJoinCount++;
                this.stats.waitForExistingRefreshHitCount++;
                setRequestDecision('wait-for-existing-refresh');
                await this.loadingPromise;
            }

            if (this.data === null) {
                this.stats.coldLoadCount++;
                setRequestDecision('cold-load');
                await this.refresh('cold-start');
                return this.sliceResult(offset, limit, query, false);
            }

            const isStale = Date.now() - this.lastRefreshTime > this.staleTTL;
            if (waitedForExistingRefresh && !isStale) {
                return this.sliceResult(offset, limit, query, false);
            }

            if (isStale && !waitForRefresh) {
                this.stats.staleHitCount++;
                setRequestDecision('stale-hit');
                this.refreshInBackground();
                return this.sliceResult(offset, limit, query, true);
            }

            if (isStale && waitForRefresh) {
                setRequestDecision('wait-for-refresh');
                try {
                    await this.refresh('foreground');
                } catch {
                    // Return stale data if refresh fails
                }
                return this.sliceResult(offset, limit, query, false);
            }

            if (!requestDecision) {
                this.stats.freshHitCount++;
                setRequestDecision('fresh-hit');
            }
            return this.sliceResult(offset, limit, query, false);
        } finally {
            this.emitStats();
        }
    }

    invalidate(): void {
        this.lastRefreshTime = 0;
        this.stats.invalidateCount++;
        this.stats.lastInvalidateAt = new Date().toISOString();
        this.emitStats();
    }

    private sliceResult(
        offset: number,
        limit: number,
        query: string | undefined,
        fromCache: boolean
    ): { sessions: T[]; total: number; fromCache: boolean } {
        let filtered = this.data!;
        if (query && query.trim()) {
            const q = query.trim().toLowerCase();
            filtered = filtered.filter(s => this.matchFn(s, q));
        }
        const total = filtered.length;
        const sessions = filtered.slice(offset, offset + limit);
        return { sessions, total, fromCache };
    }

    private async refresh(mode: RefreshMode): Promise<void> {
        if (this.loadingPromise) {
            this.stats.inFlightJoinCount++;
            await this.loadingPromise;
            return;
        }

        const startedAtMs = Date.now();
        this.stats.refreshCount++;
        if (mode === 'background') {
            this.stats.backgroundRefreshCount++;
        } else {
            this.stats.foregroundRefreshCount++;
        }
        this.stats.lastRefreshMode = mode;
        this.stats.lastRefreshStartedAt = new Date(startedAtMs).toISOString();

        this.loadingPromise = this.loader();
        try {
            this.data = await this.loadingPromise;
            this.lastRefreshTime = Date.now();
            this.stats.refreshSuccessCount++;
        } catch (error) {
            this.stats.refreshErrorCount++;
            throw error;
        } finally {
            const finishedAtMs = Date.now();
            this.stats.lastRefreshFinishedAt = new Date(finishedAtMs).toISOString();
            this.stats.lastRefreshDurationMs = finishedAtMs - startedAtMs;
            this.loadingPromise = null;
            this.emitStats();
        }
    }

    private refreshInBackground(): void {
        if (this.loadingPromise) return;

        this.refresh('background').catch(() => {
            // keep stale data on error
        });
    }

    private emitStats(): void {
        if (!this.onStatsChanged || this.emitQueued) {
            return;
        }

        this.emitQueued = true;
        queueMicrotask(() => {
            this.emitQueued = false;
            const snapshot: SessionCacheRuntimeStats = { ...this.stats };
            Promise.resolve(this.onStatsChanged!(snapshot)).catch(() => {
                // Ignore stats persistence failures.
            });
        });
    }
}

export function matchFields(query: string, fields: (string | null | undefined)[]): boolean {
    for (const field of fields) {
        if (field && field.toLowerCase().includes(query)) {
            return true;
        }
    }
    return false;
}
