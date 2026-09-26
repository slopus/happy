/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
} from './types';
import { Socket } from 'socket.io-client';
import { createRpcLatency, parseRpcLatencyRequest } from '@slopus/happy-wire';

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly logger: (message: string, data?: any) => void;
    private socket: Socket | null = null;
    /**
     * When set, only these methods are dispatched. Enforced here rather than at
     * registration so a handler registered later — or one this class gains in a
     * future change — cannot become a bypass simply by existing.
     * Null on every BYOS machine, which leaves dispatch exactly as it was.
     */
    private methodPolicy: ((method: string) => { error: string; code: string } | null) | null = null;
    private managedAllowlist: ReadonlySet<string> | null = null;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        if (this.socket) {
            this.socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    /**
     * Restricts dispatch to `methods`. Irreversible for the life of the
     * manager: a managed runtime never returns to the unrestricted surface.
     */
    setManagedAllowlist(methods: readonly string[]): void {
        this.managedAllowlist = new Set(methods);
    }

    /** Internal host policy, independent of managed identity and enforced for late registrations too. */
    setMethodPolicy(policy: (method: string) => { error: string; code: string } | null): void {
        this.methodPolicy = policy;
    }

    /** Registered method names without the machine scope prefix. */
    listMethods(): string[] {
        const prefix = `${this.scopePrefix}:`;
        return [...this.handlers.keys()].map((method) => (
            method.startsWith(prefix) ? method.slice(prefix.length) : method
        ));
    }

    unregisterHandler(method: string): void {
        const prefixedMethod = this.getPrefixedMethod(method);
        this.handlers.delete(prefixedMethod);

        if (this.socket) {
            this.socket.emit('rpc-unregister', { method: prefixedMethod });
        }
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        const requestTrace = request?.method === this.getPrefixedMethod('daemon-session-state')
            ? parseRpcLatencyRequest(request.rpcLatency) : undefined;
        if (!requestTrace) return this.executeRequest(request);
        const trace = createRpcLatency(requestTrace);
        const end = trace.begin('daemon-total');
        try {
            const result = await this.executeRequest(request, trace);
            end('resolved');
            return { result, rpcLatency: trace.snapshot() };
        } catch (error) { end('rejected'); throw error; }
    }

    private async executeRequest(request: RpcRequest, trace?: ReturnType<typeof createRpcLatency>): Promise<any> {
        try {
            const prefix = `${this.scopePrefix}:`;
            const bareMethod = request.method.startsWith(prefix) ? request.method.slice(prefix.length) : request.method;
            const refusal = this.methodPolicy?.(bareMethod);
            if (refusal) return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, refusal));
            if (this.managedAllowlist) {
                const prefix = `${this.scopePrefix}:`;
                const bare = request.method.startsWith(prefix)
                    ? request.method.slice(prefix.length)
                    : request.method;
                if (!this.managedAllowlist.has(bare)) {
                    this.logger('[RPC] [MANAGED] Method not permitted', { method: request.method });
                    return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, {
                        error: `${bare} is not available on a managed runtime; use the managed dispatch RPCs`,
                        code: 'MANAGED_CAPABILITY_REQUIRED',
                    }));
                }
            }

            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                const errorResponse = { error: 'Method not found' };
                const encryptedError = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
                return encryptedError;
            }

            // Decrypt the incoming params
            const decode = () => decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(request.params));
            const decryptedParams = trace ? trace.measureSync('daemon-decrypt', decode) : decode();

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method });
            const result = await (trace ? trace.measure('daemon-handler', () => Promise.resolve(handler(decryptedParams))) : handler(decryptedParams));
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const encode = () => encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, result));
            const encryptedResponse = trace ? trace.measureSync('daemon-encrypt', encode) : encode();
            this.logger('[RPC] Sending encrypted response', { method: request.method, responseLength: encryptedResponse.length });
            return encryptedResponse;
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', { error });
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
        }
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket;
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
