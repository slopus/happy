import { io, Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { ApiEncryption } from './apiEncryption';

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
    private encryption: ApiEncryption | null = null;
    private state: SyncSocketState = {
        isConnected: false,
        connectionStatus: 'disconnected',
        lastError: null
    };

    // Listeners
    private listeners: Set<SyncSocketListener> = new Set();
    private messageHandlers: Map<string, (data: any) => void> = new Map();

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: ApiEncryption) {
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

        this.updateState({ connectionStatus: 'connecting' });

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
        this.updateState({
            isConnected: false,
            connectionStatus: 'disconnected'
        });
    }

    //
    // State Management
    //

    private updateState(updates: Partial<SyncSocketState>) {
        this.state = { ...this.state, ...updates };
        this.notifyListeners();
    }

    private notifyListeners() {
        this.listeners.forEach(listener => listener(this.state));
    }

    getState() {
        return { ...this.state };
    }

    //
    // Listener Management
    //

    addListener(listener: SyncSocketListener) {
        this.listeners.add(listener);
        // Immediately notify with current state
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

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

    async rpc<R, A>(sessionId: string, method: string, params: A): Promise<R> {
        const result = await this.socket!.emitWithAck('rpc-call', {
            method: `${sessionId}:${method}`,
            params: this.encryption!.encryptRaw(params)
        });
        if (result.ok) {
            return this.encryption?.decryptRaw(result.result) as R;
        }
        throw new Error('RPC call failed');
    }

    send(event: string, data: any) {
        if (!this.socket || !this.state.isConnected) {
            console.warn('SyncSocket: Cannot send message, not connected');
            return false;
        }
        this.socket.emit(event, data);
        return true;
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

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            console.log('SyncSocket: Connected');
            this.updateState({
                isConnected: true,
                connectionStatus: 'connected',
                lastError: null
            });
        });

        this.socket.on('disconnect', (reason) => {
            console.log('SyncSocket: Disconnected', reason);
            this.updateState({
                isConnected: false,
                connectionStatus: 'disconnected'
            });
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            console.error('SyncSocket: Connection error', error);
            this.updateState({
                connectionStatus: 'error',
                lastError: error
            });
        });

        this.socket.on('error', (error) => {
            console.error('SyncSocket: Error', error);
            this.updateState({
                connectionStatus: 'error',
                lastError: error
            });
        });

        // Message handling
        this.socket.onAny((event, data) => {
            // console.log('SyncSocket: Message received', event, data);
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();