import { io, Socket } from 'socket.io-client';

export interface SyncEngineConfig {
    endpoint: string;
    token: string;
}

export type SyncEngineListener = (state: SyncEngineState) => void;

export interface SyncEngineState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

class SyncEngine {
    private socket: Socket | null = null;
    private config: SyncEngineConfig | null = null;
    private state: SyncEngineState = {
        isConnected: false,
        connectionStatus: 'disconnected',
        lastError: null
    };
    private listeners: Set<SyncEngineListener> = new Set();
    private messageHandlers: Map<string, (data: any) => void> = new Map();

    initialize(config: SyncEngineConfig) {
        this.config = config;
        this.connect();
    }

    private updateState(updates: Partial<SyncEngineState>) {
        this.state = { ...this.state, ...updates };
        this.notifyListeners();
    }

    private notifyListeners() {
        this.listeners.forEach(listener => listener(this.state));
    }

    addListener(listener: SyncEngineListener) {
        this.listeners.add(listener);
        // Immediately notify with current state
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        this.updateState({ connectionStatus: 'connecting' });

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
    }

    private setupEventHandlers() {
        if (!this.socket) return;

        this.socket.on('connect', () => {
            console.log('SyncEngine: Connected');
            this.updateState({
                isConnected: true,
                connectionStatus: 'connected',
                lastError: null
            });
        });

        this.socket.on('disconnect', (reason) => {
            console.log('SyncEngine: Disconnected', reason);
            this.updateState({
                isConnected: false,
                connectionStatus: 'disconnected'
            });
        });

        this.socket.on('connect_error', (error) => {
            console.error('SyncEngine: Connection error', error);
            this.updateState({
                connectionStatus: 'error',
                lastError: error
            });
        });

        this.socket.on('error', (error) => {
            console.error('SyncEngine: Error', error);
            this.updateState({
                connectionStatus: 'error',
                lastError: error
            });
        });

        // Set up dynamic message handlers
        this.socket.onAny((event, data) => {
            console.log('SyncEngine: Message received', event, data);
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
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

    send(event: string, data: any) {
        if (!this.socket || !this.state.isConnected) {
            console.warn('SyncEngine: Cannot send message, not connected');
            return false;
        }

        this.socket.emit(event, data);
        return true;
    }

    getState() {
        return { ...this.state };
    }

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;
            
            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }
}

// Global singleton instance
export const syncEngine = new SyncEngine();