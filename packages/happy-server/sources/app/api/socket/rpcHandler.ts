import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";
import { Redis } from "ioredis";

const RPC_KEY_PREFIX = 'rpc:user:';
const RPC_TTL_SECONDS = 60;

function rpcKey(userId: string, method: string): string {
    return `${RPC_KEY_PREFIX}${userId}:method:${method}`;
}

/**
 * In-memory fallback for standalone mode (no Redis).
 */
function inMemoryRpcHandler(userId: string, socket: Socket, io: Server, rpcListeners: Map<string, Socket>) {

    socket.on('rpc-register', async (data: any) => {
        try {
            const { method } = data;
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'register', error: 'Invalid method name' });
                return;
            }
            rpcListeners.set(method, socket);
            socket.emit('rpc-registered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
            socket.emit('rpc-error', { type: 'register', error: 'Internal error' });
        }
    });

    socket.on('rpc-unregister', async (data: any) => {
        try {
            const { method } = data;
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'unregister', error: 'Invalid method name' });
                return;
            }
            if (rpcListeners.get(method) === socket) {
                rpcListeners.delete(method);
            }
            socket.emit('rpc-unregistered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
            socket.emit('rpc-error', { type: 'unregister', error: 'Internal error' });
        }
    });

    socket.on('rpc-call', async (data: any, callback: (response: any) => void) => {
        try {
            const { method, params } = data;
            if (!method || typeof method !== 'string') {
                callback?.({ ok: false, error: 'Invalid parameters: method is required' });
                return;
            }
            const targetSocket = rpcListeners.get(method);
            if (!targetSocket || !targetSocket.connected) {
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }
            if (targetSocket === socket) {
                callback?.({ ok: false, error: 'Cannot call RPC on the same socket' });
                return;
            }
            try {
                const response = await targetSocket.timeout(30000).emitWithAck('rpc-request', { method, params });
                callback?.({ ok: true, result: response });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                callback?.({ ok: false, error: errorMsg });
            }
        } catch (error) {
            callback?.({ ok: false, error: 'Internal error' });
        }
    });

    socket.on('disconnect', () => {
        const methodsToRemove: string[] = [];
        for (const [method, registeredSocket] of rpcListeners.entries()) {
            if (registeredSocket === socket) {
                methodsToRemove.push(method);
            }
        }
        methodsToRemove.forEach(method => rpcListeners.delete(method));
    });
}

/**
 * Redis-backed RPC handler for multi-replica deployments.
 * Registrations stored in Redis with TTL. Calls routed cross-replica
 * via io.to(socketId).emitWithAck() through the Redis adapter.
 *
 * Keys are NEVER deleted on call failure — the 60s TTL handles cleanup.
 * Deleting on failure causes cascading permanent breakage because
 * refreshRpcRegistrations can't refresh a key that doesn't exist.
 */
function redisRpcHandler(userId: string, socket: Socket, io: Server, redis: Redis) {
    const registeredMethods: Set<string> = new Set();

    socket.on('rpc-register', async (data: any) => {
        try {
            const { method } = data;
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'register', error: 'Invalid method name' });
                return;
            }
            const key = rpcKey(userId, method);
            await redis.set(key, socket.id, 'EX', RPC_TTL_SECONDS);
            registeredMethods.add(method);
            socket.emit('rpc-registered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
            socket.emit('rpc-error', { type: 'register', error: 'Internal error' });
        }
    });

    socket.on('rpc-unregister', async (data: any) => {
        try {
            const { method } = data;
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'unregister', error: 'Invalid method name' });
                return;
            }
            const key = rpcKey(userId, method);
            const currentSocketId = await redis.get(key);
            if (currentSocketId === socket.id) {
                await redis.del(key);
            }
            registeredMethods.delete(method);
            socket.emit('rpc-unregistered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
            socket.emit('rpc-error', { type: 'unregister', error: 'Internal error' });
        }
    });

    socket.on('rpc-call', async (data: any, callback: (response: any) => void) => {
        try {
            const { method, params } = data;
            if (!method || typeof method !== 'string') {
                callback?.({ ok: false, error: 'Invalid parameters: method is required' });
                return;
            }

            const key = rpcKey(userId, method);
            const targetSocketId = await redis.get(key);

            if (!targetSocketId) {
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }

            if (targetSocketId === socket.id) {
                callback?.({ ok: false, error: 'Cannot call RPC on the same socket' });
                return;
            }

            try {
                const responses = await io.to(targetSocketId).timeout(30000).emitWithAck('rpc-request', {
                    method,
                    params
                });

                if (!responses || responses.length === 0) {
                    callback?.({ ok: false, error: 'RPC target not reachable' });
                    return;
                }

                callback?.({ ok: true, result: responses[0] });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                callback?.({ ok: false, error: errorMsg });
            }
        } catch (error) {
            callback?.({ ok: false, error: 'Internal error' });
        }
    });

    socket.on('disconnect', async () => {
        try {
            const pipeline = redis.pipeline();
            for (const method of registeredMethods) {
                const key = rpcKey(userId, method);
                pipeline.eval(
                    `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
                    1, key, socket.id
                );
            }
            await pipeline.exec();
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error cleaning up RPC registrations on disconnect: ${error}`);
        }
        registeredMethods.clear();
    });
}

/**
 * Refresh TTLs for all RPC registrations owned by this socket.
 */
export async function refreshRpcRegistrations(userId: string, socketId: string, redis: Redis) {
    try {
        const pattern = rpcKey(userId, '*');
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            if (keys.length > 0) {
                const pipeline = redis.pipeline();
                for (const key of keys) {
                    pipeline.eval(
                        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`,
                        1, key, socketId, RPC_TTL_SECONDS
                    );
                }
                await pipeline.exec();
            }
        } while (cursor !== '0');
    } catch (error) {
        log({ module: 'websocket', level: 'error' }, `Error refreshing RPC TTLs: ${error}`);
    }
}

export function rpcHandler(userId: string, socket: Socket, io: Server, rpcStore: { type: 'redis', redis: Redis } | { type: 'memory', map: Map<string, Socket> }) {
    if (rpcStore.type === 'redis') {
        redisRpcHandler(userId, socket, io, rpcStore.redis);
    } else {
        inMemoryRpcHandler(userId, socket, io, rpcStore.map);
    }
}
