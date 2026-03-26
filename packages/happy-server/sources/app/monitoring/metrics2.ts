import { register, Counter, Gauge, Histogram } from 'prom-client';
import { db } from '@/storage/db';
import { forever } from '@/utils/forever';
import { delay } from '@/utils/delay';
import { shutdownSignal } from '@/utils/shutdown';

// Application metrics
export const websocketConnectionsGauge = new Gauge({
    name: 'websocket_connections_total',
    help: 'Number of active WebSocket connections',
    labelNames: ['type'] as const,
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
    labelNames: ['event_type'] as const,
    registers: [register]
});

export const httpRequestsCounter = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [register]
});

export const httpRequestDurationHistogram = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
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

// WebSocket connection tracking
const connectionCounts = {
    'user-scoped': 0,
    'session-scoped': 0,
    'machine-scoped': 0
};

export function incrementWebSocketConnection(type: 'user-scoped' | 'session-scoped' | 'machine-scoped'): void {
    connectionCounts[type]++;
    websocketConnectionsGauge.set({ type }, connectionCounts[type]);
}

export function decrementWebSocketConnection(type: 'user-scoped' | 'session-scoped' | 'machine-scoped'): void {
    connectionCounts[type] = Math.max(0, connectionCounts[type] - 1);
    websocketConnectionsGauge.set({ type }, connectionCounts[type]);
}

/**
 * Queries record counts from all major tables and updates Prometheus gauges.
 *
 * ## Multi-Process Safety (Read-Only and Idempotent)
 *
 * This function is safe to run on every server process simultaneously:
 *
 * 1. **All queries are read-only.** The function executes `count()` queries on four tables.
 *    No writes, no side effects on the database. Multiple processes issuing the same counts
 *    in parallel produce identical results (or near-identical if rows are being inserted
 *    concurrently, which is expected and harmless).
 *
 * 2. **Prometheus gauges are process-local.** Each process maintains its own `prom-client`
 *    registry. The `/metrics` endpoint on each process reports its own gauge values. When
 *    running behind a load balancer, Prometheus scrapes each pod independently — duplicate
 *    gauge values across pods are expected and correct for `Gauge` metrics (Prometheus
 *    deduplicates or labels by instance).
 *
 * 3. **No cross-process coordination needed.** Unlike timeout sweeps, there is no state
 *    mutation to guard against. The worst case is N× the read queries (one per process),
 *    which is tolerable for lightweight `SELECT count(*)` index scans on a 60-second interval.
 *
 * ## Future Optimization: Leader Election
 *
 * At high replica counts, running identical count queries on every process wastes DB
 * connections and CPU. A leader election mechanism (PostgreSQL advisory locks or Redis
 * `SET NX PX`) could restrict this to a single process. However, the per-pod Prometheus
 * scraping model actually expects each pod to report its own metrics, so the alternative
 * would be a shared metrics push model — significantly more complex for minimal gain.
 *
 * See `docs/plans/multiprocess-architecture.md` for the full design rationale.
 */
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

/**
 * Starts the background database metrics updater on a 60-second interval.
 *
 * Multi-process safe: see `updateDatabaseMetrics()` documentation above.
 * Each process runs its own independent metrics loop — no coordination required.
 * Leader election is deferred as an optimization for high replica counts.
 */
export function startDatabaseMetricsUpdater(): void {
    forever('database-metrics-updater', async () => {
        await updateDatabaseMetrics();
        
        // Wait 60 seconds before next update
        await delay(60 * 1000, shutdownSignal);
    });
}

// Export the register for combining metrics
export { register };