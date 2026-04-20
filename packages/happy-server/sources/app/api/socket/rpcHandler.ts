import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";
import type { RemoteSocket } from "socket.io";
import type { DefaultEventsMap } from "socket.io/dist/typed-events";
import { Counter, Histogram, register } from 'prom-client';

// RPC routing uses Socket.IO rooms. A daemon registering method M for user U
// joins room `rpc:U:M`. Callers look the daemon up cross-replica via
// io.in(room).fetchSockets() — supplied by the cluster adapter (the streams
// adapter inherits from ClusterAdapterWithHeartbeat, which implements both
// fetchSockets-cross-replica and broadcast-ack-cross-replica).
//
// No Redis keys, no TTLs, no Lua, no keep-alive refresh path. On disconnect
// Socket.IO removes the socket from all rooms automatically.

const RPC_ROOM_PREFIX = 'rpc:';
const RPC_CALL_TIMEOUT_MS = 30_000;
const RPC_PRESENCE_POLL_MS = 2_000;
// Timeouts for cross-replica fetchSockets during the reconnect grace window.
// Exponential backoff: 2s → 4s → 8s. Reduces stream pressure under load
// (fewer timed-out requests flooding the stream) while giving later attempts
// more time to succeed when Redis is slow.
const RPC_LOOKUP_FETCH_TIMEOUTS_MS = [2_000, 4_000, 8_000];
// Timeout for in-flight presence-poll fetchSockets. Must be << RPC_CALL_TIMEOUT_MS
// so a dead replica doesn't stall each poll for the full adapter heartbeatTimeout
// (10s). 500ms keeps daemon-death detection responsive (~1s).
const RPC_PRESENCE_FETCH_TIMEOUT_MS = 500;
// How long an rpc-call waits for the daemon socket to appear in the room when
// the room is empty at call time (e.g. brief daemon reconnect window). With
// exponential backoff (2s, 4s, 8s) + 200ms sleep, iterations take 2.2s, 4.2s,
// 8.2s. 15s gives ~3 iterations with increasing timeouts — fewer requests
// under load while still catching a daemon mid-reconnect.
const RPC_RECONNECT_GRACE_MS = 15_000;
const RPC_RECONNECT_POLL_MS = 200;

const rpcCallCounter = new Counter({
    name: 'rpc_calls_total',
    help: 'Total RPC calls by method and outcome',
    labelNames: ['method', 'result'] as const,
    registers: [register]
});

const rpcCallDuration = new Histogram({
    name: 'rpc_call_duration_seconds',
    help: 'RPC call duration from receipt to response',
    labelNames: ['method', 'result'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
    registers: [register]
});

const rpcLookupRetries = new Histogram({
    name: 'rpc_lookup_retries',
    help: 'Number of grace-window polls before finding daemon (0 = instant)',
    labelNames: ['method'] as const,
    buckets: [0, 1, 2, 3, 4, 5, 6, 7],
    registers: [register]
});

const rpcFetchSocketsTimeouts = new Counter({
    name: 'rpc_fetchsockets_timeouts_total',
    help: 'Cross-replica fetchSockets timeouts by context',
    labelNames: ['context'] as const,
    registers: [register]
});

function rpcRoom(userId: string, method: string): string {
    return `${RPC_ROOM_PREFIX}${userId}:${method}`;
}

/**
 * Strip the scope prefix (machineId/sessionId) from a prefixed method name
 * to get the base method for metrics labels. Wire format: "cm9xyz123:bash" -> "bash".
 * Falls back to "unknown" if no colon separator found.
 */
function baseMethodName(prefixedMethod: string): string {
    const lastColon = prefixedMethod.lastIndexOf(':');
    return lastColon >= 0 ? prefixedMethod.substring(lastColon + 1) : prefixedMethod;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RoomSockets = RemoteSocket<DefaultEventsMap, any>[];

/**
 * fetchSockets(room) wrapped with a caller-specified timeout. Returns `[]`
 * and logs on failure (cluster-adapter request timeout, peer replica
 * unresponsive). Use RPC_LOOKUP_FETCH_TIMEOUT_MS for daemon lookups (initial
 * + grace window) and RPC_PRESENCE_FETCH_TIMEOUT_MS for in-flight presence
 * polling.
 */
async function fetchRoomSockets(io: Server, room: string, timeoutMs: number, context: 'lookup' | 'presence' = 'lookup'): Promise<RoomSockets> {
    try {
        return await io.in(room)
            .timeout(timeoutMs)
            .fetchSockets();
    } catch (error) {
        rpcFetchSocketsTimeouts.inc({ context });
        log({ module: 'websocket' }, `fetchSockets failed for ${room} (timeout=${timeoutMs}ms): ${error}`);
        return [];
    }
}

/**
 * Poll fetchRoomSockets until it returns at least one socket OR `maxMs`
 * elapses. Uses exponential backoff on fetch timeouts (2s, 4s, 8s) to
 * reduce stream pressure when Redis is slow — fewer requests in flight
 * means less amplification of the timeout → retry → timeout spiral.
 */
async function waitForRoomMember(io: Server, room: string, maxMs: number, metricMethod: string): Promise<RoomSockets> {
    const deadline = Date.now() + maxMs;
    let polls = 0;
    while (true) {
        const timeoutMs = RPC_LOOKUP_FETCH_TIMEOUTS_MS[Math.min(polls, RPC_LOOKUP_FETCH_TIMEOUTS_MS.length - 1)];
        const sockets = await fetchRoomSockets(io, room, timeoutMs);
        if (sockets.length > 0) {
            rpcLookupRetries.observe({ method: metricMethod }, polls);
            return sockets;
        }
        if (Date.now() >= deadline) {
            rpcLookupRetries.observe({ method: metricMethod }, polls);
            return sockets;
        }
        polls++;
        await sleep(RPC_RECONNECT_POLL_MS);
    }
}

export function rpcHandler(userId: string, socket: Socket, io: Server) {

    socket.on('rpc-register', (data: any) => {
        try {
            const { method } = data ?? {};
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'register', error: 'Invalid method name' });
                return;
            }
            socket.join(rpcRoom(userId, method));
            socket.emit('rpc-registered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
            socket.emit('rpc-error', { type: 'register', error: 'Internal error' });
        }
    });

    socket.on('rpc-unregister', (data: any) => {
        try {
            const { method } = data ?? {};
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'unregister', error: 'Invalid method name' });
                return;
            }
            socket.leave(rpcRoom(userId, method));
            socket.emit('rpc-unregistered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
            socket.emit('rpc-error', { type: 'unregister', error: 'Internal error' });
        }
    });

    socket.on('rpc-call', async (data: any, callback: (response: any) => void) => {
        const startTime = Date.now();
        const { method, params } = data ?? {};

        const finish = (result: string) => {
            const durationSec = (Date.now() - startTime) / 1000;
            const m = baseMethodName(method || 'unknown');
            rpcCallCounter.inc({ method: m, result });
            rpcCallDuration.observe({ method: m, result }, durationSec);
        };

        try {
            if (!method || typeof method !== 'string') {
                finish('invalid_params');
                callback?.({ ok: false, error: 'Invalid parameters: method is required' });
                return;
            }

            // 1. Find the daemon socket(s) cross-replica via the adapter.
            // If the room is empty OR fetchSockets fails (peer replica
            // unresponsive — fetchRoomSockets logs and returns []) fall
            // through to the wait-for-reconnect grace window.
            const room = rpcRoom(userId, method);
            let targets = await fetchRoomSockets(io, room, RPC_LOOKUP_FETCH_TIMEOUTS_MS[0]);
            if (targets.length === 0) {
                targets = await waitForRoomMember(io, room, RPC_RECONNECT_GRACE_MS, baseMethodName(method));
            }

            if (targets.length === 0) {
                finish('not_available');
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }
            if (targets.length > 1) {
                log({ module: 'websocket', level: 'warn' },
                    `Multiple sockets in ${room} (${targets.length}); using first`);
            }

            const target = targets[0];
            if (target.id === socket.id) {
                finish('self_call');
                callback?.({ ok: false, error: 'Cannot call RPC on the same socket' });
                return;
            }

            // 2. Single-target emit with timeout — works cross-replica via adapter.
            //
            // Race against a presence poll that aborts fast if the target leaves
            // the room. WHY: emitWithAck has no idea the target socket is dead;
            // when the daemon's pod gets killed mid-call, the cluster adapter's
            // outgoing BROADCAST request is queued waiting for a BROADCAST_ACK
            // that will never come, and the request only times out at the user-
            // set RPC_CALL_TIMEOUT_MS (30s). Heartbeat-based pod liveness
            // detection in the adapter takes ~10s and doesn't proactively
            // cancel pending broadcasts. Polling fetchSockets is the only way
            // to detect "the target socket is gone" and abort fast (~2-4s).
            //
            // Requires 2 consecutive empty polls before declaring disconnect
            // to avoid false positives from transient Redis/adapter timeouts.
            const ackPromise = target.timeout(RPC_CALL_TIMEOUT_MS)
                .emitWithAck('rpc-request', { method, params });

            let presenceAlive = true;
            const presencePoll = (async () => {
                let consecutiveMisses = 0;
                while (presenceAlive) {
                    await sleep(RPC_PRESENCE_POLL_MS);
                    if (!presenceAlive) return;
                    const stillThere = await fetchRoomSockets(io, room, RPC_PRESENCE_FETCH_TIMEOUT_MS, 'presence');
                    if (!stillThere.some(s => s.id === target.id)) {
                        consecutiveMisses++;
                        if (consecutiveMisses >= 2) {
                            throw new Error('RPC target disconnected');
                        }
                    } else {
                        consecutiveMisses = 0;
                    }
                }
            })();

            try {
                const response = await Promise.race([ackPromise, presencePoll]);
                finish('success');
                callback?.({ ok: true, result: response });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                finish(errorMsg === 'RPC target disconnected' ? 'target_disconnected' : 'timeout');
                callback?.({ ok: false, error: errorMsg });
            } finally {
                presenceAlive = false;
            }
        } catch (error) {
            finish('internal_error');
            log({ module: 'websocket', level: 'error' }, `Error in rpc-call: ${error}`);
            callback?.({ ok: false, error: 'Internal error' });
        }
    });

    // No disconnect handler — Socket.IO removes the socket from all rooms
    // automatically, and the cluster adapter syncs the removal to other replicas.
}
