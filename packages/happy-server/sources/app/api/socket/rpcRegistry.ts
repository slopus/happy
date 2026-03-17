import type { Socket } from "socket.io";

const rpcListenersByUser = new Map<string, Map<string, Socket>>();

export function getOrCreateUserRpcListeners(userId: string): Map<string, Socket> {
    let listeners = rpcListenersByUser.get(userId);
    if (!listeners) {
        listeners = new Map<string, Socket>();
        rpcListenersByUser.set(userId, listeners);
    }
    return listeners;
}

export function cleanupUserRpcSocket(userId: string, socket: Socket) {
    const listeners = rpcListenersByUser.get(userId);
    if (!listeners) {
        return;
    }

    for (const [method, registeredSocket] of listeners.entries()) {
        if (registeredSocket === socket) {
            listeners.delete(method);
        }
    }

    if (listeners.size === 0) {
        rpcListenersByUser.delete(userId);
    }
}

export async function invokeUserRpc(
    userId: string,
    method: string,
    params: any,
    timeoutMs: number = 30000
) {
    const listeners = rpcListenersByUser.get(userId);
    if (!listeners) {
        throw new Error('No RPC listeners registered for user');
    }

    const targetSocket = listeners.get(method);
    if (!targetSocket || !targetSocket.connected) {
        throw new Error(`RPC method not available: ${method}`);
    }

    const response = await targetSocket.timeout(timeoutMs).emitWithAck('rpc-request', {
        method,
        params,
    });
    return response;
}

export function hasUserRpcMethod(userId: string, method: string): boolean {
    const listeners = rpcListenersByUser.get(userId);
    if (!listeners) {
        return false;
    }
    const targetSocket = listeners.get(method);
    return !!targetSocket?.connected;
}

export function listConnectedUserRpcMethods(userId: string): string[] {
    const listeners = rpcListenersByUser.get(userId);
    if (!listeners) {
        return [];
    }

    const methods: string[] = [];
    for (const [method, socket] of listeners.entries()) {
        if (socket.connected) {
            methods.push(method);
        }
    }
    return methods;
}
