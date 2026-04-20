import { register, Counter, Gauge, Histogram } from 'prom-client';
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

// Database metrics updater
export async function updateDatabaseMetrics(): Promise<void> {
    // Query counts for each table
    const [accountCount, sessionCount, messageCount, machineCount] = await Promise.all([
        db.account.count(),
        db.session.count(),
        db.sessionMessage.count(),
        db.machine.count()
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

// Export the register for combining metrics
export { register };