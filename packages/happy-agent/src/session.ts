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

type SessionContentEnvelope = {
    role?: unknown;
    content?: unknown;
};

function checkIdleState(
    metadata: unknown | null,
    agentState: unknown | null,
): 'archived' | boolean {
    const meta = metadata as Record<string, unknown> | null;
    if (meta?.lifecycleState === 'archived') {
        return 'archived';
    }

    const state = agentState as Record<string, unknown> | null;
    if (!state) {
        return false;
    }
    const controlledByUser = state.controlledByUser === true;
    const requests = state.requests;
    const hasRequests = requests != null
        && typeof requests === 'object'
        && !Array.isArray(requests)
        && Object.keys(requests as Record<string, unknown>).length > 0;
    return !controlledByUser && !hasRequests;
}

function getTurnEvent(content: unknown): { type: 'turn-start' | 'turn-end'; turnId: string | null } | null {
    if (content == null || typeof content !== 'object' || Array.isArray(content)) {
        return null;
    }

    const envelope = content as SessionContentEnvelope;
    if (envelope.role !== 'session') {
        return null;
    }

    const body = envelope.content as { turn?: unknown; ev?: { t?: unknown } } | null;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }

    if (body.ev?.t !== 'turn-start' && body.ev?.t !== 'turn-end') {
        return null;
    }

    return {
        type: body.ev.t,
        turnId: typeof body.turn === 'string' ? body.turn : null,
    };
}

function isReadyEvent(content: unknown): boolean {
    if (content == null || typeof content !== 'object' || Array.isArray(content)) {
        return false;
    }

    const envelope = content as SessionContentEnvelope;
    if (envelope.role !== 'agent') {
        return false;
    }

    const body = envelope.content as { type?: unknown; data?: { type?: unknown } } | null;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return false;
    }

    return body.type === 'event' && body.data?.type === 'ready';
}

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
            const cleanup = () => {
                clearTimeout(timeout);
                this.removeListener('state-change', onStateChange);
                this.removeListener('disconnected', onDisconnect);
            };

            const result = checkIdleState(this.metadata, this.agentState);
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
                const r = checkIdleState(this.metadata, this.agentState);
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

    waitForTurnCompletion(timeoutMs = 300_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let sawActivity = false;
            let activeTurnId: string | null = null;
            let sawTurnStart = false;
            let sawNonReadyMessage = false;

            const cleanup = () => {
                clearTimeout(timeout);
                this.removeListener('message', onMessage);
                this.removeListener('state-change', onStateChange);
                this.removeListener('disconnected', onDisconnect);
            };

            const finish = (error?: Error) => {
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            const timeout = setTimeout(() => {
                finish(new Error('Timeout waiting for agent turn completion'));
            }, timeoutMs);

            const onMessage = (message: { content: unknown }) => {
                sawActivity = true;

                const turnEvent = getTurnEvent(message.content);
                if (turnEvent) {
                    if (turnEvent.type === 'turn-start') {
                        sawTurnStart = true;
                        sawNonReadyMessage = true;
                        activeTurnId = turnEvent.turnId;
                        return;
                    }

                    if (activeTurnId == null || turnEvent.turnId == null || turnEvent.turnId === activeTurnId) {
                        finish();
                    }
                    return;
                }

                if (isReadyEvent(message.content)) {
                    if (sawTurnStart || sawNonReadyMessage) {
                        finish();
                    }
                    return;
                }

                sawNonReadyMessage = true;
            };

            const onStateChange = () => {
                if (!sawActivity || sawTurnStart) {
                    return;
                }

                const result = checkIdleState(this.metadata, this.agentState);
                if (result === 'archived') {
                    finish(new Error('Session is archived'));
                } else if (result === true) {
                    finish();
                }
            };

            const onDisconnect = () => {
                finish(new Error('Socket disconnected while waiting for agent turn completion'));
            };

            this.on('message', onMessage);
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
