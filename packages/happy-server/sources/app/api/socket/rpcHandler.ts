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
// Timeout for presence-poll fetchSockets. Must be << RPC_CALL_TIMEOUT_MS so a
// dead replica that never replies to FETCH_SOCKETS doesn't itself stall the
// poll for the cluster-adapter default of 5s.
const RPC_PRESENCE_FETCH_TIMEOUT_MS = 500;
// How long an rpc-call waits for the daemon socket to appear in the room when
// the room is empty at call time (e.g. brief daemon reconnect window). Set to
// 10s — 2× the streams adapter's 5s heartbeat interval — so cross-replica
// room discovery has time to converge after a pod restart. Lower values cause
// transient "method not available" failures for ~5s after every rolling
// deploy when the daemon's reconnect lands on a freshly-started replica.
const RPC_RECONNECT_GRACE_MS = 10_000;
const RPC_RECONNECT_POLL_MS = 200;

function rpcRoom(userId: string, method: string): string {
    return `${RPC_ROOM_PREFIX}${userId}:${method}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll io.in(room).fetchSockets() until it returns at least one socket OR
 * `maxMs` elapses. Used to give a daemon a brief window to reconnect when an
 * rpc-call arrives during a transient disconnect.
 */
async function waitForRoomMember(io: Server, room: string, maxMs: number): Promise<RemoteSocket<DefaultEventsMap, any>[]> {
    const deadline = Date.now() + maxMs;
    while (true) {
        let sockets: RemoteSocket<DefaultEventsMap, any>[] = [];
        try {
            sockets = await io.in(room)
                .timeout(RPC_PRESENCE_FETCH_TIMEOUT_MS)
                .fetchSockets();
        } catch (error) {
            // Cross-replica fetchSockets timed out — a peer replica didn't
            // respond within RPC_PRESENCE_FETCH_TIMEOUT_MS. Expected during
            // pod cycling / brief partitions. Treat as "nobody here" and
            // keep polling until the grace window elapses.
            log({ module: 'websocket' }, `waitForRoomMember fetchSockets failed for ${room}: ${error}`);
            sockets = [];
        }
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
            // If the room is empty OR fetchSockets times out (an unresponsive
            // replica blocks the cross-replica request) fall through to the
            // wait-for-reconnect grace window.
            const room = rpcRoom(userId, method);
            let targets: Awaited<ReturnType<typeof waitForRoomMember>> = [];
            try {
                targets = await io.in(room)
                    .timeout(RPC_PRESENCE_FETCH_TIMEOUT_MS)
                    .fetchSockets();
            } catch (error) {
                log({ module: 'websocket' }, `rpc-call initial fetchSockets failed for ${room}: ${error}`);
                targets = [];
            }

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
            // Race against a presence poll that aborts fast if the target leaves
            // the room (pod death, daemon disconnect). Without this, emitWithAck
            // sits on a dead socketId for the full RPC_CALL_TIMEOUT_MS.
            const ackPromise = target.timeout(RPC_CALL_TIMEOUT_MS)
                .emitWithAck('rpc-request', { method, params });

            let presenceAlive = true;
            const presencePoll = (async () => {
                while (presenceAlive) {
                    await new Promise((r) => setTimeout(r, RPC_PRESENCE_POLL_MS));
                    if (!presenceAlive) return;
                    let stillThere;
                    try {
                        stillThere = await io.in(room)
                            .timeout(RPC_PRESENCE_FETCH_TIMEOUT_MS)
                            .fetchSockets();
                    } catch (error) {
                        // Adapter cross-replica request timed out: a replica is
                        // unresponsive. Treat as disconnect for the purpose of
                        // fast-failing this RPC.
                        log({ module: 'websocket' }, `presence-poll fetchSockets failed for ${room}: ${error}`);
                        throw new Error('RPC target disconnected');
                    }
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
