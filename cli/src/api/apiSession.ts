import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import axios from 'axios';
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageContent, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { claimMessageQueueV1Next, clearMessageQueueV1InFlight, discardMessageQueueV1All, parseMessageQueueV1 } from './messageQueueV1';
import { addDiscardedCommittedMessageLocalIds } from './discardedCommittedMessageLocalIds';
import { recordToolTraceEvent } from '@/agent/toolTrace/toolTrace';

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
    | { type: 'token_count'; [key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private disconnectedSendLogged = false;
    private readonly pendingMaterializedLocalIds = new Set<string>();
    private userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private snapshotSyncInFlight: Promise<void> | null = null;

    /**
     * Returns the latest known agentState (may be stale if socket is disconnected).
     * Useful for rebuilding in-memory caches (e.g. permission allowlists) without server changes.
     */
    getAgentStateSnapshot(): AgentState | null {
        return this.agentState;
    }

    private logSendWhileDisconnected(context: string, details?: Record<string, unknown>): void {
        if (this.socket.connected || this.disconnectedSendLogged) return;
        this.disconnectedSendLogged = true;
        logger.debug(
            `[API] Socket not connected; emitting ${context} anyway (socket.io should buffer until reconnection).`,
            details
        );
    }

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

        // A user-scoped socket is used to observe our own materialized pending-queue messages.
        //
        // Server-side broadcasting skips the sender connection, so a session-scoped agent that emits a
        // transcript message will not receive its own "new-message" update. Without observing the
        // materialized message, the agent can't enqueue it for processing or clear messageQueueV1.inFlight.
        //
        // A second (user-scoped) connection will still receive the broadcast, letting us safely
        // drive the normal update pipeline without server changes.
        this.userSocket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'user-scoped' as const,
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false,
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            this.disconnectedSendLogged = false;
            this.rpcHandlerManager.onSocketConnect(this.socket);

            // Resumed sessions (inactive-session-resume) start with metadataVersion/agentStateVersion = -1.
            // If the user enqueued pending messages before this agent connected, the corresponding metadata
            // update happened "in the past" and won't be replayed over the socket. Syncing a snapshot here
            // ensures messageQueueV1 is visible so popPendingMessage() can materialize the first queued item.
            if (this.metadataVersion < 0 || this.agentStateVersion < 0) {
                void this.syncSessionSnapshotFromServer({ reason: 'connect' });
            }
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
        this.socket.on('update', (data: Update) => this.handleUpdate(data, { source: 'session-scoped' }));

        this.userSocket.on('update', (data: Update) => this.handleUpdate(data, { source: 'user-scoped' }));

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    private syncSessionSnapshotFromServer(opts: { reason: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async () => {
            try {
                const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10_000,
                });

                const sessions = (response?.data as any)?.sessions;
                if (!Array.isArray(sessions)) {
                    return;
                }

                const raw = sessions.find((s: any) => s && typeof s === 'object' && s.id === this.sessionId);
                if (!raw) {
                    return;
                }

                // Sync metadata if it is newer than our local view.
                const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : null;
                const rawMetadata = typeof raw.metadata === 'string' ? raw.metadata : null;
                if (rawMetadata && nextMetadataVersion !== null && nextMetadataVersion > this.metadataVersion) {
                    const decrypted = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(rawMetadata));
                    if (decrypted) {
                        this.metadata = decrypted;
                        this.metadataVersion = nextMetadataVersion;
                        this.emit('metadata-updated');
                    }
                }

                // Sync agent state if it is newer than our local view.
                const nextAgentStateVersion = typeof raw.agentStateVersion === 'number' ? raw.agentStateVersion : null;
                const rawAgentState = typeof raw.agentState === 'string' ? raw.agentState : null;
                if (nextAgentStateVersion !== null && nextAgentStateVersion > this.agentStateVersion) {
                    this.agentState = rawAgentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(rawAgentState)) : null;
                    this.agentStateVersion = nextAgentStateVersion;
                }
            } catch (error) {
                logger.debug('[API] Failed to sync session snapshot from server', { reason: opts.reason, error });
            }
        })();

        this.snapshotSyncInFlight = p.finally(() => {
            if (this.snapshotSyncInFlight === p) {
                this.snapshotSyncInFlight = null;
            }
        });

        return this.snapshotSyncInFlight;
    }

    private kickUserSocketConnect(): void {
        if (this.closed) return;
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        if (this.userSocket.connected) return;
        try {
            this.userSocket.connect();
        } catch {
            // ignore; transcript recovery will handle missed updates
        }
    }

    private maybeScheduleUserSocketDisconnect(): void {
        if (this.closed) return;
        if (this.pendingMaterializedLocalIds.size > 0) return;
        if (!this.userSocket.connected) return;
        if (this.userSocketDisconnectTimer) return;

        // Short idle grace to avoid thrashing if multiple pending items get materialized back-to-back.
        this.userSocketDisconnectTimer = setTimeout(() => {
            this.userSocketDisconnectTimer = null;
            if (this.pendingMaterializedLocalIds.size > 0) return;
            if (!this.userSocket.connected) return;
            try {
                this.userSocket.disconnect();
            } catch {
                // ignore
            }
        }, 2_000);
        this.userSocketDisconnectTimer.unref?.();
    }

    private handleUpdate(data: Update, opts: { source: 'session-scoped' | 'user-scoped' }): void {
        try {
            logger.debugLargeJson(`[SOCKET] [UPDATE:${opts.source}] Received update:`, data);

            if (!data.body) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                return;
            }

            if (data.body.t === 'new-message') {
                if (data.body.sid !== this.sessionId) return;
                if (data.body.message.content.t !== 'encrypted') return;

                const localId = data.body.message.localId ?? null;
                if (opts.source === 'user-scoped') {
                    if (!localId) return;
                    if (!this.pendingMaterializedLocalIds.has(localId)) {
                        return;
                    }
                    // Avoid double-processing if we get multiple copies.
                    this.pendingMaterializedLocalIds.delete(localId);
                    this.maybeScheduleUserSocketDisconnect();
                }

                const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                const bodyWithLocalId =
                    data.body.message.localId === undefined
                        ? body
                        : {
                            ...(body as any),
                            localId: data.body.message.localId,
                        };

                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', bodyWithLocalId)

                // Try to parse as user message first
                const userResult = UserMessageSchema.safeParse(bodyWithLocalId);
                if (userResult.success) {
                    if (this.pendingMessageCallback) {
                        this.pendingMessageCallback(userResult.data);
                    } else {
                        this.pendingMessages.push(userResult.data);
                    }
                    this.emit('user-message', userResult.data);
                    void this.maybeClearPendingInFlight(userResult.data.localId ?? null);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', body);
                }
                return;
            }

            if (data.body.t === 'update-session') {
                const sid = (data.body as any).sid ?? (data.body as any).id;
                if (sid !== this.sessionId) return;
                if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                    this.metadataVersion = data.body.metadata.version;
                    this.emit('metadata-updated');
                }
                if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                    this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                    this.agentStateVersion = data.body.agentState.version;
                }
                return;
            }

            if (data.body.t === 'update-machine') {
                // Session clients shouldn't receive machine updates - log warning
                logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                return;
            }

            // If not a user message, it might be a permission response or other message type
            this.emit('message', data.body);
        } catch (error) {
            logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
        }
    }

    private async waitForTranscriptLocalId(localId: string, opts?: { maxWaitMs?: number }): Promise<{
        id: string;
        seq: number;
        localId: string | null;
        content: { t: 'encrypted'; c: string };
    } | null> {
        const maxWaitMs = opts?.maxWaitMs ?? 5_000;
        const startedAt = Date.now();
        while (Date.now() - startedAt < maxWaitMs) {
            const found = await this.findTranscriptMessageByLocalId(localId);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 150));
        }
        return null;
    }

    private async findTranscriptMessageByLocalId(localId: string): Promise<{
        id: string;
        seq: number;
        localId: string | null;
        content: { t: 'encrypted'; c: string };
    } | null> {
        try {
            const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${this.sessionId}/messages`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10_000,
            });
            const messages = (response?.data as any)?.messages;
            if (!Array.isArray(messages)) return null;
            const found = messages.find((m: any) => m && typeof m === 'object' && m.localId === localId);
            if (!found) return null;
            const content = found.content;
            if (!content || content.t !== 'encrypted' || typeof content.c !== 'string') return null;
            if (typeof found.id !== 'string') return null;
            if (typeof found.seq !== 'number') return null;
            const foundLocalId = typeof found.localId === 'string' ? found.localId : null;
            return { id: found.id, seq: found.seq, localId: foundLocalId, content: { t: 'encrypted', c: content.c } };
        } catch (error) {
            logger.debug('[API] Failed to fetch transcript messages for pending-queue recovery', { error });
            return null;
        }
    }

    private async recoverMaterializedLocalId(localId: string, opts?: { maxWaitMs?: number }): Promise<boolean> {
        const found = await this.waitForTranscriptLocalId(localId, opts);
        if (!found) return false;

        // Prevent later user-scoped updates from double-processing this localId.
        this.pendingMaterializedLocalIds.delete(localId);
        this.maybeScheduleUserSocketDisconnect();

        const update: Update = {
            id: `recovered-${localId}`,
            seq: 0,
            createdAt: Date.now(),
            body: {
                t: 'new-message',
                sid: this.sessionId,
                message: {
                    id: found.id,
                    seq: found.seq,
                    localId: found.localId ?? undefined,
                    content: found.content,
                },
            },
        } as Update;

        this.handleUpdate(update, { source: 'session-scoped' });
        return true;
    }

    private scheduleMaterializationRecovery(localId: string): void {
        // Belt-and-suspenders: if we fail to observe the user-scoped update (connect race, brief disconnect),
        // recover by scanning the transcript and re-injecting the message into the normal update pipeline.
        const timer = setTimeout(() => {
            if (!this.pendingMaterializedLocalIds.has(localId)) return;
            void this.recoverMaterializedLocalId(localId, { maxWaitMs: 7_500 });
        }, 500);
        timer.unref?.();
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
        if (abortSignal?.aborted) {
            return Promise.resolve(false);
        }

        const startMetadataVersion = this.metadataVersion;
        const startAgentStateVersion = this.agentStateVersion;
        if (startMetadataVersion < 0 || startAgentStateVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }
        return new Promise((resolve) => {
            let cleanedUp = false;
            const shouldWatchConnect = !this.userSocket.connected;
            const onUpdate = () => {
                cleanup();
                resolve(true);
            };
            const onConnect = () => {
                cleanup();
                resolve(true);
            };
            const onAbort = () => {
                cleanup();
                resolve(false);
            };
            const onDisconnect = () => {
                cleanup();
                resolve(false);
            };
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                this.off('metadata-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                if (shouldWatchConnect) {
                    this.userSocket.off('connect', onConnect);
                }
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            if (shouldWatchConnect) {
                this.userSocket.on('connect', onConnect);
            }
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.userSocket.on('disconnect', onDisconnect);

            // Ensure we can observe metadata updates even when the server broadcasts them only to user-scoped clients.
            // This keeps idle agents wakeable without requiring server changes.
            this.kickUserSocketConnect();

            if (abortSignal?.aborted) {
                onAbort();
                return;
            }

            // Avoid lost wakeups if a snapshot sync or socket event raced with handler registration.
            if (this.metadataVersion !== startMetadataVersion || this.agentStateVersion !== startAgentStateVersion) {
                onUpdate();
                return;
            }
            if (shouldWatchConnect && this.userSocket.connected) {
                onConnect();
                return;
            }
        });
    }

    private async maybeClearPendingInFlight(localId: string | null): Promise<void> {
        if (!localId) return;
        if (!this.socket.connected) return;
        if (!this.metadata) return;

        try {
            await this.metadataLock.inLock(async () => {
                await backoff(async () => {
                    const current = this.metadata as unknown as Record<string, unknown>;
                    const mq = parseMessageQueueV1((current as any).messageQueueV1);
                    const inFlightLocalId = mq?.inFlight?.localId ?? null;
                    if (inFlightLocalId !== localId) {
                        return;
                    }

                    const cleared = clearMessageQueueV1InFlight(current, localId);
                    if (cleared === current) {
                        return;
                    }

                    const answer = await this.socket.emitWithAck('update-metadata', {
                        sid: this.sessionId,
                        expectedVersion: this.metadataVersion,
                        metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, cleared)),
                    });
                    if (answer.result === 'success') {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                        this.metadataVersion = answer.version;
                        return;
                    }
                    if (answer.result === 'version-mismatch') {
                        if (answer.version > this.metadataVersion) {
                            this.metadataVersion = answer.version;
                            this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                        }
                        throw new Error('Metadata version mismatch');
                    }
                });
            });
        } catch (error) {
            logger.debug('[API] failed to clear messageQueueV1 inFlight', { error });
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        const isToolTraceEnabled =
            ['1', 'true', 'yes', 'on'].includes((process.env.HAPPY_STACKS_TOOL_TRACE ?? '').toLowerCase()) ||
            ['1', 'true', 'yes', 'on'].includes((process.env.HAPPY_LOCAL_TOOL_TRACE ?? '').toLowerCase()) ||
            ['1', 'true', 'yes', 'on'].includes((process.env.HAPPY_TOOL_TRACE ?? '').toLowerCase());

        if (isToolTraceEnabled) {
            const redactClaudeToolPayload = (value: unknown, key?: string): unknown => {
                const REDACT_KEYS = new Set([
                    'content',
                    'text',
                    'old_string',
                    'new_string',
                    'oldContent',
                    'newContent',
                ]);

                if (typeof value === 'string') {
                    if (key && REDACT_KEYS.has(key)) return `[redacted ${value.length} chars]`;
                    if (value.length <= 1_000) return value;
                    return `${value.slice(0, 1_000)}…(truncated ${value.length - 1_000} chars)`;
                }

                if (typeof value !== 'object' || value === null) return value;

                if (Array.isArray(value)) {
                    const sliced = value.slice(0, 50).map((v) => redactClaudeToolPayload(v));
                    if (value.length <= 50) return sliced;
                    return [...sliced, `…(truncated ${value.length - 50} items)`];
                }

                const entries = Object.entries(value as Record<string, unknown>);
                const out: Record<string, unknown> = {};
                const sliced = entries.slice(0, 200);
                for (const [k, v] of sliced) out[k] = redactClaudeToolPayload(v, k);
                if (entries.length > 200) out._truncatedKeys = entries.length - 200;
                return out;
            };

            // Claude tool calls/results are embedded inside message.content[] (tool_use/tool_result).
            // Record only tool blocks (never user text).
            //
            // Note: tool_result blocks can appear in either assistant or user messages depending on Claude
            // control mode and SDK message routing. We key off the presence of structured blocks, not role.
            const contentBlocks = (body as any)?.message?.content;
            if (Array.isArray(contentBlocks)) {
                for (const block of contentBlocks) {
                    if (!block || typeof block !== 'object') continue;
                    const type = (block as any)?.type;
                    if (type === 'tool_use') {
                        const id = (block as any)?.id;
                        const name = (block as any)?.name;
                        if (typeof id !== 'string' || typeof name !== 'string') continue;
                        recordToolTraceEvent({
                            direction: 'outbound',
                            sessionId: this.sessionId,
                            protocol: 'claude',
                            provider: 'claude',
                            kind: 'tool-call',
                            payload: {
                                type: 'tool_use',
                                id,
                                name,
                                input: redactClaudeToolPayload((block as any)?.input),
                            },
                        });
                    } else if (type === 'tool_result') {
                        const toolUseId = (block as any)?.tool_use_id;
                        if (typeof toolUseId !== 'string') continue;
                        recordToolTraceEvent({
                            direction: 'outbound',
                            sessionId: this.sessionId,
                            protocol: 'claude',
                            provider: 'claude',
                            kind: 'tool-result',
                            payload: {
                                type: 'tool_result',
                                tool_use_id: toolUseId,
                                content: redactClaudeToolPayload((block as any)?.content, 'content'),
                            },
                        });
                    }
                }
            }
        }

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

        this.logSendWhileDisconnected('Claude session message', { type: body.type });

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
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

        if (body?.type === 'tool-call' || body?.type === 'tool-call-result') {
            recordToolTraceEvent({
                direction: 'outbound',
                sessionId: this.sessionId,
                protocol: 'codex',
                provider: 'codex',
                kind: body.type,
                payload: body,
            });
        }
        
        this.logSendWhileDisconnected('Codex message', { type: body?.type });

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(
        provider: 'gemini' | 'codex' | 'claude' | 'opencode',
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) {
        const normalizedBody: ACPMessageData = (() => {
            if (body.type !== 'tool-result') return body;
            if (typeof (body as any).isError === 'boolean') return body;
            const output = (body as any).output as unknown;
            if (!output || typeof output !== 'object' || Array.isArray(output)) return body;
            const record = output as Record<string, unknown>;
            const status = typeof record.status === 'string' ? record.status : null;
            const error = typeof record.error === 'string' ? record.error : null;
            const isError = Boolean(error && error.length > 0) || status === 'failed' || status === 'cancelled' || status === 'error';
            return isError ? ({ ...(body as any), isError: true } as ACPMessageData) : body;
        })();

        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: normalizedBody
            },
            meta: {
                sentFrom: 'cli',
                ...(opts?.meta && typeof opts.meta === 'object' ? opts.meta : {}),
            }
        };

        if (
            normalizedBody.type === 'tool-call' ||
            normalizedBody.type === 'tool-result' ||
            normalizedBody.type === 'permission-request' ||
            normalizedBody.type === 'file-edit' ||
            normalizedBody.type === 'terminal-output'
        ) {
            recordToolTraceEvent({
                direction: 'outbound',
                sessionId: this.sessionId,
                protocol: 'acp',
                provider,
                kind: normalizedBody.type,
                payload: normalizedBody,
                localId: opts?.localId,
            });
        }
        
        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: normalizedBody.type, hasMessage: 'message' in normalizedBody });
        this.logSendWhileDisconnected(`${provider} ACP message`, { type: normalizedBody.type });
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));

        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted,
            localId: opts?.localId,
        });
    }

    sendUserTextMessage(text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) {
        const content: MessageContent = {
            role: 'user',
            content: { type: 'text', text },
            meta: {
                sentFrom: 'cli',
                ...(opts?.meta && typeof opts.meta === 'object' ? opts.meta : {}),
            },
        };

        this.logSendWhileDisconnected('User text message', { length: text.length });
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted,
            localId: opts?.localId,
        });
    }

    async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
        const take = typeof opts?.take === 'number' && opts.take > 0 ? Math.min(opts.take, 150) : 150;
        try {
            const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${this.sessionId}/messages`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10_000,
            });
            const raw = (response?.data as any)?.messages;
            if (!Array.isArray(raw)) return [];
            const sliced = raw.slice(0, take);

            const items: Array<{ role: 'user' | 'agent'; text: string; createdAt: number }> = [];
            for (const msg of sliced) {
                const content = msg?.content;
                if (!content || content.t !== 'encrypted' || typeof content.c !== 'string') continue;
                const decrypted = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(content.c)) as any;
                const role = decrypted?.role;
                if (role !== 'user' && role !== 'agent') continue;

                let text: string | null = null;
                const body = decrypted?.content;
                if (role === 'user') {
                    if (body?.type === 'text' && typeof body.text === 'string') {
                        text = body.text;
                    }
                } else {
                    if (body?.type === 'text' && typeof body.text === 'string') {
                        text = body.text;
                    } else if (body?.type === 'acp') {
                        const data = body?.data;
                        if (data?.type === 'message' && typeof data.message === 'string') {
                            text = data.message;
                        } else if (data?.type === 'reasoning' && typeof data.message === 'string') {
                            text = data.message;
                        }
                    }
                }

                if (!text || text.trim().length === 0) continue;
                items.push({
                    role,
                    text,
                    createdAt: typeof msg.createdAt === 'number' ? msg.createdAt : 0,
                });
            }

            // API returns newest first; normalize to chronological.
            items.sort((a, b) => a.createdAt - b.createdAt);
            return items.map((v) => ({ role: v.role, text: v.text }));
        } catch (error) {
            logger.debug('[API] Failed to fetch transcript messages for ACP import', { error });
            return [];
        }
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

        this.logSendWhileDisconnected('session event', { eventType: event.type });

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));

        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });
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
                // Costs are not currently calculated (placeholder values).
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
                if (this.metadataVersion < 0) {
                    await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
                    if (this.metadataVersion < 0) {
                        logger.debug('[API] updateMetadata skipped: metadataVersion is still unknown');
                        return;
                    }
                }
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
                if (this.agentStateVersion < 0) {
                    await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
                    if (this.agentStateVersion < 0) {
                        logger.debug('[API] updateAgentState skipped: agentStateVersion is still unknown');
                        return;
                    }
                }
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
        this.closed = true;
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        this.pendingMaterializedLocalIds.clear();
        try {
            this.userSocket.close();
        } catch {
            // ignore
        }
        this.socket.close();
    }

    peekPendingMessageQueueV1Preview(opts?: { maxPreview?: number }): { count: number; preview: string[] } {
        const maxPreview = opts?.maxPreview ?? 3;
        if (!this.metadata) return { count: 0, preview: [] };
        const mq = parseMessageQueueV1((this.metadata as any).messageQueueV1);
        if (!mq) return { count: 0, preview: [] };

        const items = [
            ...(mq.inFlight ? [mq.inFlight] : []),
            ...mq.queue,
        ];

        const preview: string[] = [];
        for (const item of items.slice(0, maxPreview)) {
            try {
                const raw = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(item.message)) as any;
                const displayText = raw?.meta?.displayText;
                const text = raw?.content?.text;
                const resolved = typeof displayText === 'string' ? displayText : typeof text === 'string' ? text : null;
                preview.push(resolved ? resolved : '<unable to decode queued message>');
            } catch {
                preview.push('<unable to decode queued message>');
            }
        }

        return { count: items.length, preview };
    }

    async discardPendingMessageQueueV1All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number> {
        if (!this.socket.connected) {
            return 0;
        }
        if (!this.metadata) {
            return 0;
        }

        let discardedCount = 0;

        await this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata as unknown as Record<string, unknown>;
                const result = discardMessageQueueV1All(current, { now: Date.now(), reason: opts.reason });
                if (!result || result.discarded.length === 0) {
                    discardedCount = 0;
                    return;
                }

                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, result.metadata)),
                });

                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    discardedCount = result.discarded.length;
                    return;
                }

                if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                }

                // Hard error - ignore
                discardedCount = 0;
            });
        });

        return discardedCount;
    }

    async discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number> {
        if (!this.socket.connected) {
            return 0;
        }
        if (!this.metadata) {
            return 0;
        }

        const localIds = opts.localIds.filter((id) => typeof id === 'string' && id.length > 0);
        if (localIds.length === 0) {
            return 0;
        }

        let addedCount = 0;

        await this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata as unknown as Record<string, unknown>;

                const existingRaw = (current as any).discardedCommittedMessageLocalIds;
                const existing = Array.isArray(existingRaw) ? existingRaw.filter((v) => typeof v === 'string') : [];
                const existingSet = new Set(existing);
                const uniqueNew = localIds.filter((id) => !existingSet.has(id));
                if (uniqueNew.length === 0) {
                    addedCount = 0;
                    return;
                }

                const nextMetadata = addDiscardedCommittedMessageLocalIds(current, uniqueNew);
                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, nextMetadata)),
                });

                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    addedCount = uniqueNew.length;
                    return;
                }

                if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                }

                // Hard error - ignore
                addedCount = 0;
            });
        });

        return addedCount;
    }

    /**
     * Materialize one metadata-backed queued message (messageQueueV1) into the normal session transcript.
     *
     * We claim the oldest queued item in encrypted session metadata, then emit it through
     * the normal transcript message pipeline (idempotent via (sessionId, localId)).
     *
     * The inFlight marker is cleared only after we observe the materialized user message
     * coming back from the server (to avoid losing messages on crashes between emit and persist).
     */
    async popPendingMessage(): Promise<boolean> {
        if (!this.socket.connected) {
            return false;
        }
        if (!this.metadata) {
            return false;
        }
        try {
            // Start the user-scoped socket early so it has time to connect before we emit the materialized
            // transcript message (otherwise we may miss the broadcast update and need transcript recovery).
            this.kickUserSocketConnect();

            const inFlight = await this.metadataLock.inLock<{ localId: string; message: string; wasExistingInFlight: boolean } | null>(async () => {
                let claimedInFlight: { localId: string; message: string; wasExistingInFlight: boolean } | null = null;
                await backoff(async () => {
                    const current = this.metadata as unknown as Record<string, unknown>;
                    const claimed = claimMessageQueueV1Next(current, Date.now());
                    if (!claimed) {
                        claimedInFlight = null;
                        return;
                    }

                    // Persist claim (if needed) so other agents don't process the same queued item.
                    const wasExistingInFlight = claimed.metadata === current;
                    if (claimed.metadata !== current) {
                        const answer = await this.socket.emitWithAck('update-metadata', {
                            sid: this.sessionId,
                            expectedVersion: this.metadataVersion,
                            metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, claimed.metadata)),
                        });
                        if (answer.result === 'success') {
                            this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                            this.metadataVersion = answer.version;
                        } else if (answer.result === 'version-mismatch') {
                            if (answer.version > this.metadataVersion) {
                                this.metadataVersion = answer.version;
                                this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                            }
                            throw new Error('Metadata version mismatch');
                        }
                    }

                    claimedInFlight = { localId: claimed.inFlight.localId, message: claimed.inFlight.message, wasExistingInFlight };
                });
                return claimedInFlight;
            });

            if (!inFlight) {
                return false;
            }
            const inFlightLocalId = inFlight.localId;

            // If the queue already had an inFlight item, we may have missed the socket update (or restarted)
            // and re-emitting with the same localId will be idempotent server-side (no broadcast update).
            // Recover by checking the transcript first.
            if (inFlight.wasExistingInFlight) {
                const recovered = await this.recoverMaterializedLocalId(inFlightLocalId, { maxWaitMs: 1_500 });
                if (recovered) {
                    return true;
                }
            }

            // Materialize the pending item into the transcript via the normal message pipeline.
            // This is idempotent because SessionMessage has a unique (sessionId, localId) constraint.
            this.pendingMaterializedLocalIds.add(inFlightLocalId);
            this.socket.emit('message', {
                sid: this.sessionId,
                message: inFlight.message,
                localId: inFlightLocalId,
            });
            this.scheduleMaterializationRecovery(inFlightLocalId);

            return true;
        } catch (error) {
            logger.debug('[API] popPendingMessage failed', { error });
            return false;
        }
    }
}
