import { register, Counter, Gauge, Histogram } from 'prom-client';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { db } from '@/storage/db';
import { forever } from '@/utils/forever';
import { delay } from '@/utils/delay';
import { shutdownSignal } from '@/utils/shutdown';
import { Socket } from 'socket.io';

// Global default labels — applied to ALL metrics at scrape time
register.setDefaultLabels({ app: 'happy-server' });

// Expected client_type values (trust whatever the client sends):
// cli-coding-session, cli-daemon, cli-control-plane, ios, android, web, desktop

interface ClientLabels {
    client: string;
    client_type: string;
}

function parseClientLabels(raw: string | undefined | null): ClientLabels {
    if (!raw) return { client: 'unknown', client_type: 'unknown' };
    const type = raw.split('/')[0].toLowerCase();
    return { client: raw, client_type: type };
}

/**
 * Extract standard metric labels from a Socket.IO socket.
 * Spread into any metric .inc() / .observe() call.
 */
export function getMetricsLabelsFromSocket(socket: Socket): ClientLabels {
    return parseClientLabels(socket.data.happyClient as string);
}

/**
 * Extract standard metric labels from a Fastify request.
 * Spread into any metric .inc() / .observe() call.
 */
export function getMetricsLabelsFromRequest(request: { headers: Record<string, string | string[] | undefined> }): ClientLabels {
    return parseClientLabels(request.headers['x-happy-client'] as string);
}

// Application metrics
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let previousUtilization = performance.eventLoopUtilization();
let maximumGcDurationMs = 0;
const gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
        if (Number.isFinite(entry.duration)) {
            maximumGcDurationMs = Math.max(maximumGcDurationMs, entry.duration);
        }
    }
});
gcObserver.observe({ entryTypes: ['gc'] });

export const eventLoopLagSecondsGauge = new Gauge({
    name: 'event_loop_lag_seconds',
    help: 'Event loop delay p99 in seconds since the previous metrics scrape',
    registers: [register],
    collect() {
        const p99Nanoseconds = eventLoopDelay.percentile(99);
        const maxNanoseconds = eventLoopDelay.max;
        this.set(Number.isFinite(p99Nanoseconds) ? p99Nanoseconds / 1e9 : 0);
        eventLoopLagMaxSecondsGauge.set(Number.isFinite(maxNanoseconds) ? maxNanoseconds / 1e9 : 0);
        const currentUtilization = performance.eventLoopUtilization();
        const intervalUtilization = performance.eventLoopUtilization(currentUtilization, previousUtilization);
        previousUtilization = currentUtilization;
        eventLoopUtilizationRatioGauge.set(Number.isFinite(intervalUtilization.utilization) ? intervalUtilization.utilization : 0);
        gcPauseMaxSecondsGauge.set(maximumGcDurationMs / 1000);
        maximumGcDurationMs = 0;
        eventLoopDelay.reset();
    }
});

// Register after the p99 collector, which samples both values before one reset.
export const eventLoopLagMaxSecondsGauge = new Gauge({
    name: 'event_loop_lag_max_seconds',
    help: 'Maximum event loop delay in seconds since the previous metrics scrape',
    registers: [register]
});

export const eventLoopUtilizationRatioGauge = new Gauge({
    name: 'event_loop_utilization_ratio',
    help: 'Event loop utilization since the previous metrics scrape; not CPU utilization',
    registers: [register]
});

export const gcPauseMaxSecondsGauge = new Gauge({
    name: 'gc_pause_max_seconds',
    help: 'Maximum GC duration reported by the asynchronous observer since the previous metrics scrape',
    registers: [register]
});

export const websocketConnectionsGauge = new Gauge({
    name: 'websocket_connections_total',
    help: 'Number of active WebSocket connections',
    labelNames: ['type', 'client', 'client_type'] as const,
    registers: [register]
});

export const sessionAliveEventsCounter = new Counter({
    name: 'session_alive_events_total',
    help: 'Total number of session-alive events',
    registers: [register]
});

export const machineAliveEventsCounter = new Counter({
    name: 'machine_alive_events_total',
    help: 'Total number of machine-alive events',
    registers: [register]
});

export const sessionCacheCounter = new Counter({
    name: 'session_cache_operations_total',
    help: 'Total session cache operations',
    labelNames: ['operation', 'result'] as const,
    registers: [register]
});

export const databaseUpdatesSkippedCounter = new Counter({
    name: 'database_updates_skipped_total',
    help: 'Number of database updates skipped due to debouncing',
    labelNames: ['type'] as const,
    registers: [register]
});

export const websocketEventsCounter = new Counter({
    name: 'websocket_events_total',
    help: 'Total WebSocket events received by type',
    labelNames: ['event_type', 'client', 'client_type'] as const,
    registers: [register]
});

export const httpRequestsCounter = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status', 'client', 'client_type'] as const,
    registers: [register]
});

export const httpRequestDurationHistogram = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status', 'client', 'client_type'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [register]
});

// Database count metrics
export const databaseRecordCountGauge = new Gauge({
    name: 'database_records_total',
    help: 'Total number of records in database tables',
    labelNames: ['table'] as const,
    registers: [register]
});

type EstimatedCountRow = {
    estimated_count: bigint | number | null;
};

async function getEstimatedRecordCount(tableName: string): Promise<number> {
    const rows = await db.$queryRaw<EstimatedCountRow[]>`
        SELECT GREATEST(reltuples, 0)::bigint AS estimated_count
        FROM pg_class
        WHERE oid = to_regclass(${tableName})
    `;
    const estimatedCount = rows[0]?.estimated_count ?? 0;
    return Number(estimatedCount);
}

// Database metrics updater
export async function updateDatabaseMetrics(): Promise<void> {
    // Use catalog estimates instead of exact COUNT(*). Exact counts are full
    // scans in Postgres and this updater runs once a minute.
    const [accountCount, sessionCount, messageCount, machineCount] = await Promise.all([
        getEstimatedRecordCount('"Account"'),
        getEstimatedRecordCount('"Session"'),
        getEstimatedRecordCount('"SessionMessage"'),
        getEstimatedRecordCount('"Machine"')
    ]);

    // Update metrics
    databaseRecordCountGauge.set({ table: 'accounts' }, accountCount);
    databaseRecordCountGauge.set({ table: 'sessions' }, sessionCount);
    databaseRecordCountGauge.set({ table: 'messages' }, messageCount);
    databaseRecordCountGauge.set({ table: 'machines' }, machineCount);
}

export function startDatabaseMetricsUpdater(): void {
    forever('database-metrics-updater', async () => {
        await updateDatabaseMetrics();
        
        // Wait 60 seconds before next update
        await delay(60 * 1000, shutdownSignal);
    });
}

// Redis stream lag — how far behind this pod's reader is from the stream head
export const redisStreamLagMsGauge = new Gauge({
    name: 'redis_stream_lag_ms',
    help: 'Milliseconds between this pod read cursor and stream HEAD',
    registers: [register]
});

// Cluster-bus health. See app/monitoring/redisHealth.ts for why these exist:
// the bus can die completely while liveness/readiness/CPU/DB all stay green.

// Peers this replica sees on the Socket.IO cluster bus (serverCount - self);
// -1 means "could not determine". With replicas >= 2 a sustained 0 means
// cross-replica lookups are silently answering local-only.
export const socketioClusterPeersGauge = new Gauge({
    name: 'socketio_cluster_peers',
    help: 'Peer replicas visible on the Socket.IO cluster bus (-1 = unknown)',
    registers: [register]
});

export const redisStreamWriteFailuresCounter = new Counter({
    name: 'redis_stream_write_failures_total',
    help: 'Failed XADD writes to the Socket.IO cluster stream, by error code',
    labelNames: ['code'] as const,
    registers: [register]
});

export const redisStreamReadFailuresCounter = new Counter({
    name: 'redis_stream_read_failures_total',
    help: 'Failed XREAD commands on the Socket.IO cluster bus',
    labelNames: ['bus', 'code'] as const,
    registers: [register]
});

export const redisStreamReadDuration = new Histogram({
    name: 'redis_stream_read_duration_seconds',
    help: 'XREAD elapsed time including BLOCK wait, network and event-loop delay',
    labelNames: ['bus', 'result'] as const,
    buckets: [0.01, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [register]
});

export const redisStreamInfoFailuresCounter = new Counter({
    name: 'redis_stream_info_failures_total',
    help: 'Failed XINFO reads of the Socket.IO cluster stream (lag gauge goes stale while this climbs)',
    registers: [register]
});

export const redisClientErrorsCounter = new Counter({
    name: 'redis_client_errors_total',
    help: 'Connection-level ioredis client errors, by error code',
    labelNames: ['code'] as const,
    registers: [register]
});

// Export the register for combining metrics
export { register };
