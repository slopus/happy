import { io, Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private rpcHandlers: Map<string, (params: any) => Promise<any> | any> = new Map();
    private registeredRpcMethods: Set<string> = new Set();

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    //
    // RPC Handler Registration
    //

    /**
     * Register an RPC handler that can be called by other clients (e.g., daemon)
     * @param method - The method name (will be prefixed with machine/session ID by caller)
     * @param handler - The handler function
     */
    registerRpcHandler(method: string, handler: (params: any) => Promise<any> | any) {
        this.rpcHandlers.set(method, handler);

        // If connected, register with server
        if (this.socket?.connected && !this.registeredRpcMethods.has(method)) {
            this.socket.emit('rpc-register', { method });
            this.registeredRpcMethods.add(method);
        }

        return () => {
            this.rpcHandlers.delete(method);
            if (this.socket?.connected && this.registeredRpcMethods.has(method)) {
                this.socket.emit('rpc-unregister', { method });
                this.registeredRpcMethods.delete(method);
            }
        };
    }

    /**
     * Unregister an RPC handler
     */
    unregisterRpcHandler(method: string) {
        this.rpcHandlers.delete(method);
        if (this.socket?.connected && this.registeredRpcMethods.has(method)) {
            this.socket.emit('rpc-unregister', { method });
            this.registeredRpcMethods.delete(method);
        }
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A, timeout: number = 30000): Promise<R> {
        const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${sessionId}`);
        }

        const result = await this.socket!.timeout(timeout).emitWithAck('rpc-call', {
            method: `${sessionId}:${method}`,
            params: await sessionEncryption.encryptRaw(params)
        });

        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    /**
     * RPC call for machines
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A, timeout: number = 30000): Promise<R> {
        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const result = await this.socket!.timeout(timeout).emitWithAck('rpc-call', {
            method: `${machineId}:${method}`,
            params: await machineEncryption.encryptRaw(params)
        });

        if (result.ok) {
            // Try standard decryption first
            let decrypted = await machineEncryption.decryptRaw(result.result);

            // If standard decryption fails, try legacy format
            // (used for OpenClaw chat.history which uses legacy format for cross-platform compatibility)
            if (decrypted === null) {
                decrypted = machineEncryption.decryptRawLegacy(result.result);
            }

            if (decrypted === null) {
                throw new Error('Failed to decrypt machine RPC response');
            }

            return decrypted as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any, timeout: number = 30000): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        return await this.socket.timeout(timeout).emitWithAck(event, data);
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            ...options?.headers
        };

        return fetch(url, {
            ...options,
            headers
        });
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            // console.log('🔌 SyncSocket: Connected, recovered: ' + this.socket?.recovered);
            // console.log('🔌 SyncSocket: Socket ID:', this.socket?.id);
            this.updateStatus('connected');

            // Re-register all RPC handlers on connect
            for (const method of this.rpcHandlers.keys()) {
                if (!this.registeredRpcMethods.has(method)) {
                    this.socket?.emit('rpc-register', { method });
                    this.registeredRpcMethods.add(method);
                }
            }

            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        this.socket.on('disconnect', (reason) => {
            // console.log('🔌 SyncSocket: Disconnected', reason);
            this.updateStatus('disconnected');
            // Clear registered methods on disconnect - they'll be re-registered on connect
            this.registeredRpcMethods.clear();
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            // console.error('🔌 SyncSocket: Connection error', error);
            this.updateStatus('error');
        });

        this.socket.on('error', (error) => {
            // console.error('🔌 SyncSocket: Error', error);
            this.updateStatus('error');
        });

        // Message handling
        this.socket.onAny((event, data) => {
            // console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            const handler = this.messageHandlers.get(event);
            if (handler) {
                // console.log(`📥 SyncSocket: Calling handler for '${event}'`);
                handler(data);
            } else {
                // console.log(`📥 SyncSocket: No handler registered for '${event}'`);
            }
        });

        // RPC request handling
        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: any) => void) => {
            // console.log(`📥 SyncSocket: Received RPC request for '${data.method}'`);
            const handler = this.rpcHandlers.get(data.method);
            if (!handler) {
                callback({ error: 'Method not found' });
                return;
            }

            try {
                // Decrypt params using the machine encryption
                // Extract machineId from method name (format: machineId:methodName)
                const colonIndex = data.method.indexOf(':');
                if (colonIndex === -1) {
                    callback({ error: 'Invalid method format' });
                    return;
                }

                const machineId = data.method.substring(0, colonIndex);
                const machineEncryption = this.encryption?.getMachineEncryption(machineId);

                let decryptedParams: any;
                if (machineEncryption && data.params) {
                    decryptedParams = await machineEncryption.decryptRaw(data.params);
                } else {
                    // If no encryption or no params, use params as-is
                    decryptedParams = data.params;
                }

                const result = await handler(decryptedParams);

                // Encrypt the response
                let encryptedResult: any;
                if (machineEncryption && result !== undefined) {
                    encryptedResult = await machineEncryption.encryptRaw(result);
                } else {
                    encryptedResult = result;
                }

                callback(encryptedResult);
            } catch (error) {
                console.error('RPC handler error:', error);
                callback({ error: error instanceof Error ? error.message : 'Handler error' });
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();
