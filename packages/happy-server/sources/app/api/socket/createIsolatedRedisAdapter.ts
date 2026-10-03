import { installRpcPeerDiagnostics } from './rpcPeerDiagnostics';
import { log } from '@/utils/log';
import { createLogThrottle, instrumentStreamReads, redisErrorCode } from '@/app/monitoring/redisHealth';
import { redisStreamReadDuration, redisStreamReadFailuresCounter } from '@/app/monitoring/metrics2';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import type { Redis } from 'ioredis';

/*
 * socket.io awaits `restoreSession` before auth middleware for every client
 * that reconnects with a pid, and a Redis command on a half-open connection
 * never settles. On 2026-09-23 that held every reconnect in prod until the
 * client's 20s connect timeout, for ~17 minutes. Past this deadline the client
 * connects without recovery (missed events are re-fetched over REST) instead
 * of not connecting at all.
 */
export const RESTORE_SESSION_TIMEOUT_MS = 3_000;

export function createIsolatedRedisAdapter(
    writer: Redis,
    reader: Redis,
    options: Parameters<typeof createAdapter>[1],
): ReturnType<typeof createAdapter> {
    const active = new Set<ReturnType<ReturnType<typeof createAdapter>>>();
    const bus = options?.streamName === 'socket.io.managed' ? 'managed' : 'account';
    const shouldLogReadFailure = createLogThrottle(60_000);
    const shouldLogSlowRead = createLogThrottle(60_000);
    instrumentStreamReads(reader, (result, seconds, error) => {
        // Closing the last namespace intentionally disconnects its pending read.
        if (active.size === 0) return;
        redisStreamReadDuration.observe({ bus, result }, seconds);
        if (result === 'failure') {
            const code = redisErrorCode(error);
            redisStreamReadFailuresCounter.inc({ bus, code });
            if (shouldLogReadFailure(code)) {
                log({ module: 'websocket', level: 'warn' },
                    `cluster stream read failed (${bus}, ${code}, throttled to 1/min) — cross-replica routing is degraded`);
            }
        } else if (seconds > 1 && shouldLogSlowRead('slow')) {
            log({ module: 'websocket', level: 'warn' },
                `cluster stream read slow (${bus}, ${Math.round(seconds * 1000)}ms, throttled to 1/min)`);
        }
    });
    // The 0.2.x adapter runs ioredis XREAD BLOCK 100 on its publishing client.
    // Redis queues XADD behind that read, on both the requesting and replying
    // replicas. These dedicated clients share configuration, not a connection.
    // Leave all writes/recovery operations (including instrumented xadd) intact.
    writer.xread = reader.xread.bind(reader);
    /*
     * The adapter's persistSession() is declared `: void` and drops the
     * promise of its SET (0.2.3 dist/adapter.js:147-152), and socket.io calls
     * persistSession un-awaited for every recoverable disconnect
     * (dist/socket.js:544). That write used to stay pending forever on a
     * stalled connection; with `commandTimeout` it rejects, with nothing
     * holding it — and main.ts turns an unhandled rejection into
     * process.exit(1), so one client disconnecting during a Redis stall would
     * take the replica down. Attach a handler where the promise is still
     * reachable. The promise itself is returned untouched, so a caller that
     * does await this write still sees the failure.
     */
    const shouldLogPersistFailure = createLogThrottle(60_000);
    const set = writer.set.bind(writer) as (...args: unknown[]) => Promise<unknown>;
    writer.set = ((...args: unknown[]) => {
        const written = set(...args);
        written.catch((error: unknown) => {
            if (shouldLogPersistFailure('persist')) {
                log({ module: 'websocket', level: 'warn' },
                    `session state write failed (throttled to 1/min) — that client reconnects without recovery: ${error}`);
            }
        });
        return written;
    }) as unknown as Redis['set'];
    const create = createAdapter(writer, options);
    const shouldLogRestoreTimeout = createLogThrottle(60_000);
    return function (namespace) {
        const adapter = create(namespace);
        const restoreSession = adapter.restoreSession.bind(adapter);
        adapter.restoreSession = (pid, offset) => {
            let timer: NodeJS.Timeout | undefined;
            // Rejecting is how the adapter itself reports "nothing to restore";
            // socket.io catches it and connects the client fresh.
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    if (shouldLogRestoreTimeout('restore')) {
                        log({ module: 'websocket', level: 'warn' },
                            `restoreSession exceeded ${RESTORE_SESSION_TIMEOUT_MS}ms (throttled to 1/min) — connecting without recovery; Redis may be stalled`);
                    }
                    reject(new Error('restoreSession timed out'));
                }, RESTORE_SESSION_TIMEOUT_MS);
            });
            return Promise.race([restoreSession(pid, offset), deadline]).finally(() => clearTimeout(timer));
        };
        installRpcPeerDiagnostics(adapter, row => log({ module: 'rpc-peer-diagnostics' }, JSON.stringify(row)));
        active.add(adapter);
        const close = adapter.close.bind(adapter);
        adapter.close = () => {
            if (!active.delete(adapter)) return;
            // Stop the upstream poll loop before disconnecting its reader.
            close();
            if (active.size === 0) reader.disconnect();
        };
        return adapter;
    };
}
