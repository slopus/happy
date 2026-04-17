import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";
import type { RemoteSocket } from "socket.io";
import type { DefaultEventsMap } from "socket.io/dist/typed-events";

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
const RPC_PRESENCE_POLL_MS = 1_000;
// Timeout for cross-replica fetchSockets during initial daemon lookup and the
// reconnect grace window. Must be long enough for the full Redis streams
// round-trip (XADD → peer XREAD → process → XADD response → local XREAD)
// across all replicas. The cluster-adapter default heartbeatTimeout is 10s;
// 2s is well above typical healthy latency (~50-200ms) while still allowing
// ~6-7 polls within the grace window.
const RPC_LOOKUP_FETCH_TIMEOUT_MS = 2_000;
// Timeout for in-flight presence-poll fetchSockets. Must be << RPC_CALL_TIMEOUT_MS
// so a dead replica doesn't stall each poll for the full adapter heartbeatTimeout
// (10s). 500ms keeps daemon-death detection responsive (~1s).
const RPC_PRESENCE_FETCH_TIMEOUT_MS = 500;
// How long an rpc-call waits for the daemon socket to appear in the room when
// the room is empty at call time (e.g. brief daemon reconnect window). With
// RPC_LOOKUP_FETCH_TIMEOUT_MS at 2s + RPC_RECONNECT_POLL_MS at 200ms, each
// poll iteration takes ~2.2s. 15s gives ~6-7 iterations — enough to catch a
// daemon mid-reconnect after a rolling deploy or transient network drop.
const RPC_RECONNECT_GRACE_MS = 15_000;
const RPC_RECONNECT_POLL_MS = 200;

function rpcRoom(userId: string, method: string): string {
    return `${RPC_ROOM_PREFIX}${userId}:${method}`;
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
async function fetchRoomSockets(io: Server, room: string, timeoutMs: number): Promise<RoomSockets> {
    try {
        return await io.in(room)
            .timeout(timeoutMs)
            .fetchSockets();
    } catch (error) {
        log({ module: 'websocket' }, `fetchSockets failed for ${room} (timeout=${timeoutMs}ms): ${error}`);
        return [];
    }
}

/**
 * Poll fetchRoomSockets until it returns at least one socket OR `maxMs`
 * elapses. Used to give a daemon a brief window to reconnect when an
 * rpc-call arrives during a transient disconnect.
 */
async function waitForRoomMember(io: Server, room: string, maxMs: number): Promise<RoomSockets> {
    const deadline = Date.now() + maxMs;
    while (true) {
        const sockets = await fetchRoomSockets(io, room, RPC_LOOKUP_FETCH_TIMEOUT_MS);
        if (sockets.length > 0) return sockets;
        if (Date.now() >= deadline) return sockets;
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
        try {
            const { method, params } = data ?? {};
            if (!method || typeof method !== 'string') {
                callback?.({ ok: false, error: 'Invalid parameters: method is required' });
                return;
            }

            // 1. Find the daemon socket(s) cross-replica via the adapter.
            // If the room is empty OR fetchSockets fails (peer replica
            // unresponsive — fetchRoomSockets logs and returns []) fall
            // through to the wait-for-reconnect grace window.
            const room = rpcRoom(userId, method);
            let targets = await fetchRoomSockets(io, room, RPC_LOOKUP_FETCH_TIMEOUT_MS);
            if (targets.length === 0) {
                targets = await waitForRoomMember(io, room, RPC_RECONNECT_GRACE_MS);
            }

            if (targets.length === 0) {
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }
            if (targets.length > 1) {
                log({ module: 'websocket', level: 'warn' },
                    `Multiple sockets in ${room} (${targets.length}); using first`);
            }

            const target = targets[0];
            if (target.id === socket.id) {
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
            // to detect "the target socket is gone" and abort fast (~1s).
            const ackPromise = target.timeout(RPC_CALL_TIMEOUT_MS)
                .emitWithAck('rpc-request', { method, params });

            let presenceAlive = true;
            const presencePoll = (async () => {
                while (presenceAlive) {
                    await sleep(RPC_PRESENCE_POLL_MS);
                    if (!presenceAlive) return;
                    const stillThere = await fetchRoomSockets(io, room, RPC_PRESENCE_FETCH_TIMEOUT_MS);
                    if (!stillThere.some(s => s.id === target.id)) {
                        throw new Error('RPC target disconnected');
                    }
                }
            })();

            try {
                const response = await Promise.race([ackPromise, presencePoll]);
                callback?.({ ok: true, result: response });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                callback?.({ ok: false, error: errorMsg });
            } finally {
                presenceAlive = false;
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-call: ${error}`);
            callback?.({ ok: false, error: 'Internal error' });
        }
    });

    // No disconnect handler — Socket.IO removes the socket from all rooms
    // automatically, and the cluster adapter syncs the removal to other replicas.
}
