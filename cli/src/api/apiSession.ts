import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageContent, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';

type RpcHandler<T = any, R = any> = (data: T) => R | Promise<R>;
type RpcHandlerMap = Map<string, RpcHandler>;

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    private readonly secret: Uint8Array;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private rpcHandlers: RpcHandlerMap = new Map();
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();

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

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId
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
            logger.debug('Socket connected successfully');
            // Re-register all RPC handlers on reconnection
            this.reregisterHandlers();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            try {
                const method = data.method;
                const handler = this.rpcHandlers.get(method);

                if (!handler) {
                    logger.debug('[SOCKET] [RPC] [ERROR] method not found', { method });
                    const errorResponse = { error: 'Method not found' };
                    const encryptedError = encodeBase64(encrypt(errorResponse, this.secret));
                    callback(encryptedError);
                    return;
                }

                // Decrypt the incoming params
                const decryptedParams = decrypt(decodeBase64(data.params), this.secret);

                // Call the handler
                const result = await handler(decryptedParams);

                // Encrypt and return the response
                const encryptedResponse = encodeBase64(encrypt(result, this.secret));
                callback(encryptedResponse);
            } catch (error) {
                logger.debug('[SOCKET] [RPC] [ERROR] Error handling RPC request', { error });
                const errorResponse = { error: error instanceof Error ? error.message : 'Unknown error' };
                const encryptedError = encodeBase64(encrypt(errorResponse, this.secret));
                callback(encryptedError);
            }
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message' && data.body.message.content.t === 'encrypted') {
                    const body = decrypt(decodeBase64(data.body.message.content.c), this.secret);

                    logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body)

                    // Try to parse as user message first
                    const userResult = UserMessageSchema.safeParse(body);
                    if (userResult.success) {
                        // Server already filtered to only our session
                        if (this.pendingMessageCallback) {
                            this.pendingMessageCallback(userResult.data);
                        } else {
                            this.pendingMessages.push(userResult.data);
                        }
                    } else {
                        // If not a user message, it might be a permission response or other message type
                        this.emit('message', body);
                    }
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(decodeBase64(data.body.metadata.value), this.secret);
                        this.metadataVersion = data.body.metadata.version;
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(decodeBase64(data.body.agentState.value), this.secret) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        })

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
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli'
                }
            };
        }

        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        const encrypted = encodeBase64(encrypt(content, this.secret));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message.usage) {
            try {
                this.sendUsageData(body.message.usage);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    sendSessionEvent(event: { type: 'switch', mode: 'local' | 'remote' } | { type: 'message', message: string } | { type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
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
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        // logger.debug(`[API] Sending keep alive message: ${thinking}`);
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                // TODO: Calculate actual costs based on pricing
                // For now, using placeholder values
                total: 0,
                input: 0,
                output: 0
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
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
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(updated, this.secret)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(decodeBase64(answer.agentState), this.secret) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(decodeBase64(answer.agentState), this.secret) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Set a custom RPC handler for a specific method with encrypted arguments and responses
     * @param method - The method name to handle
     * @param handler - The handler function to call when the method is invoked
     */
    setHandler<T = any, R = any>(method: string, handler: RpcHandler<T, R>): void {
        // Prefix method with session ID to ensure isolation between sessions
        const prefixedMethod = `${this.sessionId}:${method}`;

        // Store the handler
        this.rpcHandlers.set(prefixedMethod, handler);

        // Register the method with the server
        this.socket.emit('rpc-register', { method: prefixedMethod });

        logger.debug('Registered RPC handler', { method, prefixedMethod });
    }

    /**
     * Re-register all RPC handlers after reconnection
     */
    private reregisterHandlers(): void {
        logger.debug('Re-registering RPC handlers after reconnection', {
            totalMethods: this.rpcHandlers.size
        });

        // Re-register all methods with the server
        for (const [prefixedMethod] of this.rpcHandlers) {
            this.socket.emit('rpc-register', { method: prefixedMethod });
            logger.debug('Re-registered method', { prefixedMethod });
        }
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
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