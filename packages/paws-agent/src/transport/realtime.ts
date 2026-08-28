import { io } from 'socket.io-client';
import { PawsAgentError } from '../client/errors';
import { PawsAgentEvents } from '../client/events';
import type { AgentLogger, CredentialProvider, ReconnectPolicy } from '../client/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../crypto/encryption';
import { RecordEncryptionStore, type RecordEncryption } from '../crypto/records';

type RealtimeSocket = {
    connected: boolean;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    connect(): unknown;
    disconnect(): unknown;
    close(): unknown;
    emit(event: string, data: unknown): unknown;
    timeout(ms: number): RealtimeSocket;
    emitWithAck(event: string, data: unknown): Promise<{ ok: boolean; result?: string; error?: string }>;
};

export type RealtimeSocketFactory = (url: string, options: Record<string, unknown>) => RealtimeSocket;

export class PawsRealtimeTransport {
    private socket: RealtimeSocket | null = null;
    private readonly serverUrl: string;
    private disposed = false;
    private manualDisconnect = false;
    private initialReady: Promise<void> | null = null;
    private resolveInitial: (() => void) | null = null;
    private rejectInitial: ((error: unknown) => void) | null = null;

    constructor(private readonly options: {
        serverUrl: string;
        credentials: CredentialProvider;
        encryption: RecordEncryptionStore;
        events: PawsAgentEvents;
        resync: () => Promise<unknown>;
        onUpdate?: (update: unknown) => void;
        logger?: AgentLogger;
        reconnect?: ReconnectPolicy;
        socketFactory?: RealtimeSocketFactory;
    }) {
        this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    }

    async connect(): Promise<void> {
        if (this.disposed) {
            throw new PawsAgentError('CONNECTION_LOST', 'Client has been disposed');
        }
        if (this.socket?.connected && !this.initialReady) {
            return;
        }
        if (this.initialReady) {
            return this.initialReady;
        }

        const credentials = await this.options.credentials.getCredentials();
        if (!credentials) {
            throw new PawsAgentError('AUTH_REQUIRED', 'Authentication required');
        }

        this.manualDisconnect = false;
        this.options.events.emit({ type: 'connection', state: 'connecting' });
        this.initialReady = new Promise<void>((resolve, reject) => {
            this.resolveInitial = resolve;
            this.rejectInitial = reject;
        });

        const socketFactory = this.options.socketFactory
            ?? ((url, socketOptions) => io(url, socketOptions) as unknown as RealtimeSocket);
        const reconnect = this.options.reconnect ?? {};
        const socket = socketFactory(this.serverUrl, {
            auth: {
                token: credentials.token,
                clientType: 'user-scoped',
                happyClient: 'paws-agent-sdk/0.1.0',
            },
            path: '/v1/updates',
            transports: ['websocket'],
            autoConnect: false,
            reconnection: true,
            reconnectionAttempts: reconnect.attempts ?? Infinity,
            reconnectionDelay: reconnect.initialDelayMs ?? 1_000,
            reconnectionDelayMax: reconnect.maxDelayMs ?? 5_000,
        });
        this.socket = socket;

        socket.on('connect', () => { void this.handleConnect(); });
        socket.on('disconnect', () => {
            if (!this.disposed && !this.manualDisconnect) {
                this.options.events.emit({ type: 'connection', state: 'reconnecting' });
            }
        });
        socket.on('connect_error', () => {
            const error = new PawsAgentError('CONNECTION_LOST', 'Unable to connect to Paws server');
            this.options.events.emit({ type: 'error', error });
            this.rejectInitial?.(error);
            this.clearInitial();
        });
        socket.on('update', update => {
            if (!this.disposed) this.options.onUpdate?.(update);
        });
        socket.connect();
        return this.initialReady;
    }

    async disconnect(): Promise<void> {
        this.manualDisconnect = true;
        this.socket?.disconnect();
        this.socket = null;
        this.clearInitial();
        if (!this.disposed) {
            this.options.events.emit({ type: 'connection', state: 'disconnected' });
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.manualDisconnect = true;
        this.rejectInitial?.(new PawsAgentError('CONNECTION_LOST', 'Client has been disposed'));
        this.socket?.close();
        this.socket = null;
        this.clearInitial();
    }

    emit(event: string, data: unknown): void {
        if (!this.socket?.connected) {
            throw new PawsAgentError('CONNECTION_LOST', 'Realtime connection is not ready');
        }
        this.socket.emit(event, data);
    }

    machineRpc<T>(machineId: string, method: string, params: unknown): Promise<T> {
        const encryption = this.options.encryption.getMachine(machineId);
        return this.rpc<T>('machine', machineId, method, params, encryption);
    }

    sessionRpc<T>(sessionId: string, method: string, params: unknown): Promise<T> {
        const encryption = this.options.encryption.getSession(sessionId);
        return this.rpc<T>('session', sessionId, method, params, encryption);
    }

    private async handleConnect(): Promise<void> {
        if (this.disposed || this.manualDisconnect) return;
        try {
            await this.options.resync();
            if (this.disposed || this.manualDisconnect) return;
            this.options.events.emit({ type: 'connection', state: 'ready' });
            this.resolveInitial?.();
            this.clearInitial();
        } catch (cause) {
            const error = cause instanceof PawsAgentError
                ? cause
                : new PawsAgentError('UNKNOWN', 'Snapshot synchronization failed', { cause });
            this.options.events.emit({ type: 'error', error });
            this.rejectInitial?.(error);
            this.clearInitial();
        }
    }

    private async rpc<T>(
        scope: 'machine' | 'session',
        id: string,
        method: string,
        params: unknown,
        encryption: RecordEncryption | undefined,
    ): Promise<T> {
        if (!encryption) {
            throw new PawsAgentError('NOT_FOUND', `${scope === 'machine' ? 'Machine' : 'Session'} snapshot not loaded`);
        }
        if (!this.socket?.connected) {
            throw new PawsAgentError(scope === 'machine' ? 'MACHINE_OFFLINE' : 'CONNECTION_LOST', 'Realtime connection is not ready');
        }

        try {
            const response = await this.socket.timeout(30_000).emitWithAck('rpc-call', {
                method: `${id}:${method}`,
                params: encodeBase64(encrypt(encryption.key, encryption.variant, params)),
            });
            if (!response.ok) {
                const timedOut = typeof response.error === 'string' && /timed? out|timeout/i.test(response.error);
                const code = timedOut
                    ? 'RPC_TIMEOUT'
                    : scope === 'machine' && response.error === 'RPC method not available'
                        ? 'MACHINE_OFFLINE'
                        : 'UNKNOWN';
                const message = code === 'RPC_TIMEOUT'
                    ? 'RPC call timed out'
                    : code === 'MACHINE_OFFLINE' ? 'Machine is offline' : 'RPC call failed';
                throw new PawsAgentError(code, message);
            }
            if (typeof response.result !== 'string') {
                throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'RPC response is missing an encrypted result');
            }
            try {
                return decrypt(encryption.key, encryption.variant, decodeBase64(response.result)) as T;
            } catch (cause) {
                throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt RPC response', { cause });
            }
        } catch (cause) {
            if (cause instanceof PawsAgentError) throw cause;
            throw new PawsAgentError('RPC_TIMEOUT', 'RPC call timed out', { cause });
        }
    }

    private clearInitial(): void {
        this.initialReady = null;
        this.resolveInitial = null;
        this.rejectInitial = null;
    }
}
