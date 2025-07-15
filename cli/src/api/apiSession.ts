import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageContent, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    private readonly secret: Uint8Array;
    private readonly sessionId: string;
    private metadata: Metadata;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private receivedMessages = new Set<string>();
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;

    constructor(token: string, secret: Uint8Array, session: Session) {
        super()
        this.token = token;
        this.secret = secret;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;

        //
        // Create socket
        //

        this.socket = io('https://handy-api.korshakov.org', {
            auth: {
                token: this.token
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.info('Socket connected successfully');
        })

        this.socket.on('disconnect', (reason) => {
            logger.warn('Socket disconnected:', reason);
        })

        this.socket.on('connect_error', (error) => {
            logger.error('Socket connection error:', error.message);
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            if (data.body.t === 'new-message' && data.body.message.content.t === 'encrypted') {
                const body = decrypt(decodeBase64(data.body.message.content.c), this.secret);

                // Try to parse as user message first
                const userResult = UserMessageSchema.safeParse(body);
                if (userResult.success) {
                    if (!this.receivedMessages.has(data.body.message.id)) {
                        this.receivedMessages.add(data.body.message.id);
                        if (this.pendingMessageCallback) {
                            this.pendingMessageCallback(userResult.data);
                        } else {
                            this.pendingMessages.push(userResult.data);
                        }
                    }
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', body);
                }
            } else if (data.body.t === 'update-session') {
                if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                    this.metadata = decrypt(decodeBase64(data.body.metadata.metadata), this.secret);
                    this.metadataVersion = data.body.metadata.version;
                }
                if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                    this.agentState = data.body.agentState.agentState ? decrypt(decodeBase64(data.body.agentState.agentState), this.secret) : null;
                    this.agentStateVersion = data.body.agentState.version;
                }
            }
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    /**
     * Send message to session
     * @param body - Message body
     */
    sendMessage(body: any) {
        let content: MessageContent = {
            role: 'agent',
            content: body
        };
        const encrypted = encodeBase64(encrypt(content, this.secret));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean) {
        this.socket.volatile.emit('session-alive', { sid: this.sessionId, time: Date.now(), thinking });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        backoff(async () => {
            let updated = handler(this.metadata);
            const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(updated, this.secret)) });
            if (answer.result === 'success') {
                this.metadata = decrypt(decodeBase64(answer.metadata), this.secret);
                this.metadataVersion = answer.version;
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.metadataVersion) {
                    this.metadataVersion = answer.version;
                    this.metadata = decrypt(decodeBase64(answer.metadata), this.secret);
                }
                throw new Error('Metadata version mismatch');
            } else if (answer.result === 'error') {
                // Hard error - ignore
            }
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        backoff(async () => {
            let updated = handler(this.agentState || {});
            const answer = await this.socket.emitWithAck('update-agent', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(updated, this.secret)) : null });
            if (answer.result === 'success') {
                this.agentState = answer.agentState ? decrypt(decodeBase64(answer.agentState), this.secret) : null;
                this.agentStateVersion = answer.version;
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.agentStateVersion) {
                    this.agentStateVersion = answer.version;
                    this.agentState = answer.agentState ? decrypt(decodeBase64(answer.agentState), this.secret) : null;
                }
                throw new Error('Agent state version mismatch');
            } else if (answer.result === 'error') {
                // Hard error - ignore
            }
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emitWithAck('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        this.socket.close();
    }
}