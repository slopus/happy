import { DistributedRpcRegistry } from "@/modules/rpc/distributedRpc";
import { log } from "@/utils/log";
import { Socket } from "socket.io";

const RPC_REQUEST_TIMEOUT_MS = 30_000;

export function rpcHandler(
    userId: string,
    socket: Socket,
    rpcListeners: Map<string, Socket>,
    registry?: DistributedRpcRegistry,
) {

    // RPC register - Register this socket as a listener for an RPC method
    socket.on('rpc-register', async (data: any) => {
        try {
            const { method } = data;

            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'register', error: 'Invalid method name' });
                return;
            }

            const previousSocket = rpcListeners.get(method);
            rpcListeners.set(method, socket);

            try {
                if (registry) {
                    await registry.register(userId, method);
                }
            } catch (error) {
                if (previousSocket) {
                    rpcListeners.set(method, previousSocket);
                } else {
                    rpcListeners.delete(method);
                }
                throw error;
            }

            socket.emit('rpc-registered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
            socket.emit('rpc-error', { type: 'register', error: 'Internal error' });
        }
    });

    // RPC unregister - Remove this socket as a listener for an RPC method
    socket.on('rpc-unregister', async (data: any) => {
        try {
            const { method } = data;

            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'unregister', error: 'Invalid method name' });
                return;
            }

            if (rpcListeners.get(method) === socket) {
                rpcListeners.delete(method);
                try {
                    if (registry) {
                        await registry.unregister(userId, method);
                    }
                } catch (error) {
                    rpcListeners.set(method, socket);
                    throw error;
                }
            }

            socket.emit('rpc-unregistered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
            socket.emit('rpc-error', { type: 'unregister', error: 'Internal error' });
        }
    });

    // RPC call - Call an RPC method on another socket of the same user
    socket.on('rpc-call', async (data: any, callback: (response: any) => void) => {
        try {
            const { method, params } = data;

            if (!method || typeof method !== 'string') {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Invalid parameters: method is required'
                    });
                }
                return;
            }

            const targetSocket = rpcListeners.get(method);
            if (targetSocket?.connected) {
                if (targetSocket === socket) {
                    if (callback) {
                        callback({
                            ok: false,
                            error: 'Cannot call RPC on the same socket'
                        });
                    }
                    return;
                }

                const startTime = Date.now();

                try {
                    const response = await targetSocket.timeout(RPC_REQUEST_TIMEOUT_MS).emitWithAck('rpc-request', {
                        method,
                        params
                    });

                    const duration = Date.now() - startTime;
                    void duration;

                    if (callback) {
                        callback({
                            ok: true,
                            result: response
                        });
                    }
                } catch (error) {
                    const duration = Date.now() - startTime;
                    void duration;

                    if (callback) {
                        callback({
                            ok: false,
                            error: error instanceof Error ? error.message : 'RPC call failed'
                        });
                    }
                }
                return;
            }

            if (registry) {
                const response = await registry.call(userId, method, params);
                if (callback) {
                    callback(response);
                }
                return;
            }

            if (callback) {
                callback({
                    ok: false,
                    error: 'RPC method not available'
                });
            }
        } catch (error) {
            if (callback) {
                callback({
                    ok: false,
                    error: 'Internal error'
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const methodsToRemove: string[] = [];
        for (const [method, registeredSocket] of rpcListeners.entries()) {
            if (registeredSocket === socket) {
                methodsToRemove.push(method);
            }
        }

        if (methodsToRemove.length === 0) {
            return;
        }

        for (const method of methodsToRemove) {
            rpcListeners.delete(method);
            if (registry) {
                void registry.unregister(userId, method).catch((error) => {
                    log({ module: 'websocket', level: 'error', error, userId, method }, `Failed to unregister distributed RPC method ${method} during disconnect`);
                });
            }
        }
    });
}
