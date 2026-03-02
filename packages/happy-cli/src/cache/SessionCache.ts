// packages/happy-cli/src/cache/SessionCache.ts

export interface SessionCacheOptions<T> {
    loader: () => Promise<T[]>;
    staleTTL?: number;
    matchFn: (session: T, query: string) => boolean;
}

export class SessionCache<T> {
    private data: T[] | null = null;
    private loadingPromise: Promise<T[]> | null = null;
    private lastRefreshTime: number = 0;
    private staleTTL: number;
    private loader: () => Promise<T[]>;
    private matchFn: (session: T, query: string) => boolean;

    constructor(options: SessionCacheOptions<T>) {
        this.loader = options.loader;
        this.staleTTL = options.staleTTL ?? 30_000;
        this.matchFn = options.matchFn;
    }

    async list(params: {
        offset: number;
        limit: number;
        query?: string;
        waitForRefresh?: boolean;
    }): Promise<{ sessions: T[]; total: number; fromCache: boolean }> {
        const { offset, limit, query, waitForRefresh } = params;

        // If waitForRefresh and a refresh is in progress, await it
        if (waitForRefresh && this.loadingPromise) {
            await this.loadingPromise;
        }

        // First call ever — must await loader
        if (this.data === null) {
            await this.refresh();
            return this.sliceResult(offset, limit, query, false);
        }

        // Check staleness
        const isStale = Date.now() - this.lastRefreshTime > this.staleTTL;

        if (isStale && !waitForRefresh) {
            // Return stale data, trigger background refresh
            this.refreshInBackground();
            return this.sliceResult(offset, limit, query, true);
        }

        if (isStale && waitForRefresh) {
            // Wait for refresh to complete, fall back to stale data on error
            try {
                await this.refresh();
            } catch {
                // Return stale data if refresh fails
            }
            return this.sliceResult(offset, limit, query, false);
        }

        return this.sliceResult(offset, limit, query, false);
    }

    invalidate(): void {
        this.lastRefreshTime = 0;
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

    private async refresh(): Promise<void> {
        if (this.loadingPromise) {
            await this.loadingPromise;
            return;
        }
        this.loadingPromise = this.loader();
        try {
            this.data = await this.loadingPromise;
            this.lastRefreshTime = Date.now();
        } finally {
            this.loadingPromise = null;
        }
    }

    private refreshInBackground(): void {
        if (this.loadingPromise) return; // already refreshing
        this.loadingPromise = this.loader();
        this.loadingPromise
            .then(data => {
                this.data = data;
                this.lastRefreshTime = Date.now();
            })
            .catch(() => {
                // keep stale data on error
            })
            .finally(() => {
                this.loadingPromise = null;
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
