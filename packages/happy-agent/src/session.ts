import { EventEmitter } from 'node:events';
import { io, Socket } from 'socket.io-client';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';
import type { EncryptionVariant } from './api';

// --- Types ---

export type SessionClientOptions = {
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: EncryptionVariant;
    token: string;
    serverUrl: string;
    initialAgentState?: unknown | null;
};

// --- SessionClient ---

export class SessionClient extends EventEmitter {
    readonly sessionId: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: EncryptionVariant;
    private socket: Socket;
    private metadata: unknown | null = null;
    private metadataVersion = 0;
    private agentState: unknown | null = null;
    private agentStateVersion = 0;

    constructor(opts: SessionClientOptions) {
        super();
        this.sessionId = opts.sessionId;
        this.encryptionKey = opts.encryptionKey;
        this.encryptionVariant = opts.encryptionVariant;
        if (opts.initialAgentState !== undefined) {
            this.agentState = opts.initialAgentState;
        }

        // Prevent unhandled 'error' event from crashing the process
        this.on('error', () => {});

        this.socket = io(opts.serverUrl, {
            auth: {
                token: opts.token,
                clientType: 'session-scoped' as const,
                sessionId: opts.sessionId,
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            autoConnect: false,
        });

        this.socket.on('connect', () => {
            this.emit('connected');
        });

        this.socket.on('disconnect', (reason: string) => {
            this.emit('disconnected', reason);
        });

        this.socket.on('connect_error', (error: Error) => {
            this.emit('connect_error', error);
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.socket.on('update', (data: any) => {
            try {
                const body = data?.body;
                if (!body) return;

                if (body.t === 'new-message' && body.message?.content?.t === 'encrypted') {
                    const msg = body.message;
                    const decrypted = decrypt(
                        this.encryptionKey,
                        this.encryptionVariant,
                        decodeBase64(msg.content.c),
                    );
                    if (decrypted === null) return;
                    this.emit('message', {
                        id: msg.id,
                        seq: msg.seq,
                        content: decrypted,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        updatedAt: msg.updatedAt,
                    });
                } else if (body.t === 'update-session') {
                    if (body.metadata && body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(
                            this.encryptionKey,
                            this.encryptionVariant,
                            decodeBase64(body.metadata.value),
                        );
                        this.metadataVersion = body.metadata.version;
                    }
                    if (body.agentState && body.agentState.version > this.agentStateVersion) {
                        this.agentState = body.agentState.value
                            ? decrypt(
                                  this.encryptionKey,
                                  this.encryptionVariant,
                                  decodeBase64(body.agentState.value),
                              )
                            : null;
                        this.agentStateVersion = body.agentState.version;
                    }
                    this.emit('state-change', {
                        metadata: this.metadata,
                        agentState: this.agentState,
                    });
                }
            } catch (err) {
                this.emit('error', err);
            }
        });

        this.socket.connect();
    }

    sendMessage(text: string, meta?: Record<string, unknown>): void {
        const content = {
            role: 'user',
            content: {
                type: 'text',
                text,
            },
            meta: {
                sentFrom: 'happy-agent',
                ...meta,
            },
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted,
        });
    }

    getMetadata(): unknown | null {
        return this.metadata;
    }

    getAgentState(): unknown | null {
        return this.agentState;
    }

    waitForConnect(timeoutMs = 10_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.socket.connected) {
                resolve();
                return;
            }
            const timeout = setTimeout(() => {
                this.removeListener('connected', onConnect);
                this.removeListener('connect_error', onError);
                reject(new Error('Timeout waiting for socket connection'));
            }, timeoutMs);
            const onConnect = () => {
                clearTimeout(timeout);
                this.removeListener('connect_error', onError);
                resolve();
            };
            const onError = (err: Error) => {
                clearTimeout(timeout);
                this.removeListener('connected', onConnect);
                reject(err);
            };
            this.once('connected', onConnect);
            this.once('connect_error', onError);
        });
    }

    waitForIdle(timeoutMs = 300_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const checkIdle = (): 'archived' | boolean => {
                // Check if session is archived (per plan: lifecycleState must not be 'archived')
                const meta = this.metadata as Record<string, unknown> | null;
                if (meta?.lifecycleState === 'archived') {
                    return 'archived';
                }

                const state = this.agentState as Record<string, unknown> | null;
                if (!state) {
                    return false; // No state received yet, not known to be idle
                }
                const controlledByUser = state.controlledByUser === true;
                const requests = state.requests;
                const hasRequests = requests != null && typeof requests === 'object' && !Array.isArray(requests) && Object.keys(requests as Record<string, unknown>).length > 0;
                return !controlledByUser && !hasRequests;
            };

            const cleanup = () => {
                clearTimeout(timeout);
                this.removeListener('state-change', onStateChange);
                this.removeListener('disconnected', onDisconnect);
            };

            const result = checkIdle();
            if (result === 'archived') {
                reject(new Error('Session is archived'));
                return;
            }
            if (result === true) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout waiting for agent to become idle'));
            }, timeoutMs);

            const onStateChange = () => {
                const r = checkIdle();
                if (r === 'archived') {
                    cleanup();
                    reject(new Error('Session is archived'));
                } else if (r === true) {
                    cleanup();
                    resolve();
                }
            };

            const onDisconnect = () => {
                cleanup();
                reject(new Error('Socket disconnected while waiting for agent to become idle'));
            };

            this.on('state-change', onStateChange);
            this.on('disconnected', onDisconnect);
        });
    }

    sendStop(): void {
        this.socket.emit('session-end', {
            sid: this.sessionId,
            time: Date.now(),
        });
    }

    close(): void {
        this.socket.close();
    }
}
