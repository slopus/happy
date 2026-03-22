import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff, delay } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import {
    type v3,
} from '@slopus/happy-sync';
import {
    type SessionEnvelope,
    type SessionTurnEndStatus,
} from '@/legacy/sessionProtocol';
import {
    handleClaudeMessage,
    flushV3Turn,
    createV3MapperState,
    blockToolForPermission,
    unblockToolApproved,
    unblockToolRejected,
    type V3MapperState,
} from '@/claude/utils/v3Mapper';
import {
    handleCodexEvent,
    flushV3CodexTurn,
    createV3CodexMapperState,
    type V3CodexMapperState,
} from '@/codex/utils/v3Mapper';
import { SyncBridge, type SyncBridgeOpts } from './syncBridge';
import { resolveSessionScopedSyncNodeToken } from './syncNodeToken';

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private v3MapperState: V3MapperState | null = null;
    private v3CodexMapperState: V3CodexMapperState | null = null;
    private syncBridge: SyncBridge | null = null;

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);

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
            this.rpcHandlerManager.onSocketConnect(this.socket);
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    // When SyncBridge is attached, incoming messages arrive through SyncNode
                    if (this.syncBridge) return;

                    const message = data.body.message;
                    if (!message || message.content?.t !== 'encrypted') return;
                    try {
                        const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
                        logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body)
                        this.routeIncomingMessage(body);
                    } catch (error) {
                        logger.debug('[SOCKET] [UPDATE] Failed to decrypt new-message', { error });
                    }
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
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

    private routeIncomingMessage(message: unknown) {
        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userResult.data);
            } else {
                this.pendingMessages.push(userResult.data);
            }
            return;
        }
        this.emit('message', message);
    }

    private enqueueMessage(content: unknown) {
        if (!this.syncBridge) {
            logger.debug('[API] enqueueMessage called but no SyncBridge attached — message dropped', { content });
            return;
        }
        // Legacy bridge: wraps non-v3 content in a MessageWithParts envelope.
        // TODO: These paths (ACP, session protocol, events) should be migrated
        // to produce proper v3 MessageWithParts. The `as unknown` cast is
        // intentional — this envelope does NOT conform to MessageWithParts.
        const envelope = {
            info: { id: randomUUID(), role: 'system', createdAt: Date.now() },
            parts: [{ type: 'legacy-envelope', data: content }],
        };
        this.syncBridge.sendMessage(envelope as unknown as v3.MessageWithParts).catch((err) => {
            logger.debug('[API] SyncBridge sendMessage failed (enqueueMessage)', { error: err });
        });
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        // v3 only — v1 session protocol removed
        this.sendClaudeV3Message(body);
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
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

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        // v3 only — v1 turn close removed
        this.flushClaudeV3Turn();
    }

    /**
     * Attach a SyncBridge for v3 message transport.
     * When attached, v3 messages go through SyncNode instead of the legacy outbox.
     */
    async attachSyncBridge(opts: Omit<SyncBridgeOpts, 'sessionId'>): Promise<SyncBridge> {
        const sessionToken = await resolveSessionScopedSyncNodeToken({
            serverUrl: opts.serverUrl,
            sessionId: this.sessionId,
            token: opts.token,
        });
        const bridge = new SyncBridge({
            ...opts,
            token: sessionToken,
            sessionId: this.sessionId as v3.SessionID,
        });
        await bridge.connect();
        this.syncBridge = bridge;

        // Wire permission decisions from the app through to the mapper
        bridge.onPermissionDecision((decision) => {
            if (decision.decision === 'reject') {
                this.unblockToolRejectedV3(decision.permissionId, decision.reason ?? 'rejected');
            } else {
                this.unblockToolApprovedV3(decision.permissionId, decision.decision);
            }
        });

        return bridge;
    }

    getSyncBridge(): SyncBridge | null {
        return this.syncBridge;
    }

    /**
     * Send a v3 protocol message (Message + Parts canonical format) through SyncNode.
     */
    sendV3ProtocolMessage(message: v3.MessageWithParts) {
        if (!this.syncBridge) {
            logger.debug('[API] sendV3ProtocolMessage called but no SyncBridge attached — message dropped');
            return;
        }
        this.syncBridge.sendMessage(message).catch((err) => {
            logger.debug('[API] SyncBridge sendMessage failed', { error: err });
        });
    }

    /**
     * Process a Claude SDK message through the v3 mapper and send any finalized messages.
     * Also sends the in-flight assistant message as a partial update.
     */
    sendClaudeV3Message(body: RawJSONLines) {

        if (!this.v3MapperState) {
            this.v3MapperState = createV3MapperState({
                sessionID: this.sessionId,
                providerID: 'anthropic',
            });
        }

        const result = handleClaudeMessage(body, this.v3MapperState);

        // Send finalized messages (completed turns)
        for (const msg of result.messages) {
            this.sendV3ProtocolMessage(msg);
        }

        // NOTE: Do NOT send currentAssistant partial updates here.
        // Intermediate snapshots cause duplication when history is fetched.
        // Permission state changes are sent via blockToolForPermissionV3 / unblockTool*.
    }

    /**
     * Flush any in-flight v3 assistant message (e.g. on session end or turn close).
     */
    flushClaudeV3Turn() {
        if (!this.v3MapperState) return;

        const messages = flushV3Turn(this.v3MapperState);
        for (const msg of messages) {
            this.sendV3ProtocolMessage(msg);
        }
    }

    // ─── v3 permission blocking (Claude) ───────────────────────────────────────

    /**
     * Mark a tool as blocked for permission in the v3 mapper.
     * Does NOT send an envelope — the finalized message on turn completion
     * will contain the correct final state. Sending intermediate states
     * causes duplication when history is fetched.
     */
    blockToolForPermissionV3(callID: string, permission: string, patterns: string[], metadata: Record<string, unknown>): void {
        if (!this.v3MapperState) return;
        blockToolForPermission(this.v3MapperState, callID, permission, patterns, metadata);
    }

    /**
     * Mark a blocked tool as approved in the v3 mapper.
     */
    unblockToolApprovedV3(callID: string, decision: 'once' | 'always'): void {
        if (!this.v3MapperState) return;
        unblockToolApproved(this.v3MapperState, callID, decision);
    }

    /**
     * Mark a blocked tool as rejected in the v3 mapper.
     */
    unblockToolRejectedV3(callID: string, reason: string): void {
        if (!this.v3MapperState) return;
        unblockToolRejected(this.v3MapperState, callID, reason);
    }

    // ─── v3 Codex dual-write ────────────────────────────────────────────────────

    /**
     * Process a Codex event through the v3 mapper and send any finalized messages.
     */
    sendCodexV3Event(event: Record<string, unknown>): void {

        if (!this.v3CodexMapperState) {
            this.v3CodexMapperState = createV3CodexMapperState({
                sessionID: this.sessionId,
                providerID: 'openai',
            });
        }

        const result = handleCodexEvent(event, this.v3CodexMapperState);

        for (const msg of result.messages) {
            this.sendV3ProtocolMessage(msg);
        }

        // NOTE: Do NOT send currentAssistant partial updates — causes duplication.
    }

    /**
     * Flush any in-flight v3 Codex assistant message.
     */
    flushCodexV3Turn(): void {
        if (!this.v3CodexMapperState) return;

        const messages = flushV3CodexTurn(this.v3CodexMapperState);
        for (const msg of messages) {
            this.sendV3ProtocolMessage(msg);
        }
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope) {
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope) {
        if (envelope.role !== 'user') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        if (envelope.ev.t !== 'text') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        this.enqueueSessionProtocolEnvelope(envelope);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode' | 'openclaw', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        this.enqueueMessage(content);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
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
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

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
                total: costs.total,
                input: costs.input,
                output: costs.output
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
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
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
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
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
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await Promise.race([
            this.syncBridge?.flush() ?? Promise.resolve(),
            delay(10000)
        ]);
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
        logger.debug('[API] socket.close() called');
        this.syncBridge?.disconnect();
        this.socket.close();
    }
}
