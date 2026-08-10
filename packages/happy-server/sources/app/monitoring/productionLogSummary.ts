import { isProduction, summary } from '@/utils/log';

export const PRODUCTION_LOG_WINDOW_MS = 30_000;

type RequestSample = {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
};

type RouteStats = {
    requests: number;
    errors: number;
    totalDurationMs: number;
    maxDurationMs: number;
};

function percentile(values: number[], fraction: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function oneLine(value: unknown): string {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isTransactionTimeout(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
    if (candidate.code === 'P2028') return true;
    const message = `${oneLine(candidate.message)} ${oneLine(candidate.meta?.message)}`;
    return /transaction (already closed|.*expired)|expired transaction|interactive transaction.*timeout/i.test(message);
}

export class ProductionLogWindow {
    private startedAt: number;
    private requests = 0;
    private status2xx = 0;
    private status4xx = 0;
    private status5xx = 0;
    private errors = 0;
    private transactionTimeouts = 0;
    private slowRequests = 0;
    private totalDurationMs = 0;
    private maxDurationMs = 0;
    private durationsMs: number[] = [];
    private routes = new Map<string, RouteStats>();

    constructor(startedAt = Date.now()) {
        this.startedAt = startedAt;
    }

    recordRequest(sample: RequestSample): void {
        if (sample.route === '/health' && sample.statusCode < 500) return;

        this.requests += 1;
        if (sample.statusCode >= 500) this.status5xx += 1;
        else if (sample.statusCode >= 400) this.status4xx += 1;
        else if (sample.statusCode >= 200) this.status2xx += 1;

        this.totalDurationMs += sample.durationMs;
        this.maxDurationMs = Math.max(this.maxDurationMs, sample.durationMs);
        this.durationsMs.push(sample.durationMs);
        if (sample.durationMs >= 1_000) this.slowRequests += 1;

        const key = `${sample.method} ${sample.route}`;
        const route = this.routes.get(key) || { requests: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0 };
        route.requests += 1;
        if (sample.statusCode >= 500) route.errors += 1;
        route.totalDurationMs += sample.durationMs;
        route.maxDurationMs = Math.max(route.maxDurationMs, sample.durationMs);
        this.routes.set(key, route);
    }

    recordError(error: unknown): void {
        this.errors += 1;
        if (isTransactionTimeout(error)) this.transactionTimeouts += 1;
    }

    flush(now = Date.now()): string | null {
        const elapsedSeconds = Math.max(1, Math.round((now - this.startedAt) / 1_000));
        if (this.requests === 0 && this.errors === 0) {
            this.reset(now);
            return null;
        }

        const averageMs = this.requests > 0 ? this.totalDurationMs / this.requests : 0;
        const topRoutes = [...this.routes.entries()]
            .sort((a, b) => b[1].requests - a[1].requests)
            .slice(0, 3)
            .map(([route, stats]) => {
                const avgMs = stats.totalDurationMs / stats.requests;
                return `${route}:${stats.requests}req/${stats.errors}err/${Math.round(avgMs)}ms`;
            })
            .join(',');

        const message = [
            'http:summary',
            `window=${elapsedSeconds}s`,
            `requests=${this.requests}`,
            `2xx=${this.status2xx}`,
            `4xx=${this.status4xx}`,
            `5xx=${this.status5xx}`,
            `errors=${this.errors}`,
            `txTimeouts=${this.transactionTimeouts}`,
            `slow1s=${this.slowRequests}`,
            `avg=${Math.round(averageMs)}ms`,
            `p95=${Math.round(percentile(this.durationsMs, 0.95))}ms`,
            `max=${Math.round(this.maxDurationMs)}ms`,
            topRoutes ? `top=${topRoutes}` : null,
        ].filter(Boolean).join(' ');

        this.reset(now);
        return message;
    }

    private reset(now: number): void {
        this.startedAt = now;
        this.requests = 0;
        this.status2xx = 0;
        this.status4xx = 0;
        this.status5xx = 0;
        this.errors = 0;
        this.transactionTimeouts = 0;
        this.slowRequests = 0;
        this.totalDurationMs = 0;
        this.maxDurationMs = 0;
        this.durationsMs = [];
        this.routes.clear();
    }
}

const productionWindow = new ProductionLogWindow();
let summaryTimer: ReturnType<typeof setInterval> | undefined;

export function recordProductionRequest(sample: RequestSample): void {
    if (isProduction) productionWindow.recordRequest(sample);
}

export function recordProductionError(error: unknown): void {
    if (isProduction) productionWindow.recordError(error);
}

export function startProductionLogSummary(): () => void {
    if (!isProduction || summaryTimer) return () => {};

    summaryTimer = setInterval(() => {
        const message = productionWindow.flush();
        if (message) summary({ module: 'http-summary' }, message);
    }, PRODUCTION_LOG_WINDOW_MS);
    (summaryTimer as unknown as { unref?: () => void }).unref?.();

    return () => {
        if (summaryTimer) clearInterval(summaryTimer);
        summaryTimer = undefined;
    };
}
