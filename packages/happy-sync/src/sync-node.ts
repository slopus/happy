/**
 * SyncNode — the single sync primitive for Happy.
 *
 * All consumers (CLI session processes, daemon, React Native app, integration
 * tests) instantiate SyncNode to send, receive, and read state. No other sync
 * path exists.
 *
 * Two token scopes:
 * - Account-scoped: lifecycle operations (create/list/stop sessions, all session messages)
 * - Session-scoped: restricted to one session's messages
 */

import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { encryptMessage, decryptMessage, type KeyMaterial } from './encryption';
import type {
    SessionAcpxState,
    SessionAgentContent,
    SessionMessage,
    SessionToolResult,
    SessionToolUse,
} from './acpx-types';
import {
    type MessageID,
    type RuntimeConfig,
    type SessionInfo,
    type SessionID,
    type Todo,
    MessageIDSchema,
    SessionIDSchema,
    TodoSchema,
} from './sync-types';
import {
    SyncNodeTokenClaimsSchema,
    type SyncNodeTokenClaims,
    type SyncNodeToken,
} from './token';

// ─── Token claims ────────────────────────────────────────────────────────────
export { SyncNodeTokenClaimsSchema } from './token';
export type { SyncNodeTokenClaims, SyncNodeToken } from './token';

const SyncNodeSessionMetadataSchema = z.object({
    directory: z.string(),
    projectID: z.string(),
    title: z.string().optional(),
    parentID: z.string().nullable().optional(),
});
type SyncNodeSessionMetadata = z.infer<typeof SyncNodeSessionMetadataSchema>;

const SyncNodeStoredSessionMetadataSchema = z.object({
    session: SyncNodeSessionMetadataSchema,
    metadata: z.unknown().nullable().optional(),
});

type PendingPermissionMetadata = {
    id: string;
    callId: string;
    messageId?: string | null;
    tool: string;
    patterns: string[];
    metadata: Record<string, unknown>;
    allowTools?: string[];
    decision?: 'once' | 'always' | 'reject';
    reason?: string;
    resolved?: boolean;
};

type PendingQuestionMetadata = {
    id: string;
    callId: string;
    messageId?: string | null;
    questions: QuestionInfo[];
    answers?: string[][];
    resolved?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

function isSessionMessage(value: unknown): value is SessionMessage {
    if (value === 'Resume') {
        return true;
    }
    if (!isRecord(value)) {
        return false;
    }
    if ('User' in value) {
        return isRecord(value.User)
            && typeof value.User.id === 'string'
            && Array.isArray(value.User.content);
    }
    if ('Agent' in value) {
        return isRecord(value.Agent)
            && Array.isArray(value.Agent.content)
            && isRecord(value.Agent.tool_results);
    }
    return false;
}

function isSessionUserMessage(message: SessionMessage): message is Extract<SessionMessage, { User: unknown }> {
    return typeof message === 'object' && message !== null && 'User' in message;
}

function isSessionAgentMessage(message: SessionMessage): message is Extract<SessionMessage, { Agent: unknown }> {
    return typeof message === 'object' && message !== null && 'Agent' in message;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
}

function asQuestionOptions(value: unknown): QuestionOption[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((item) => {
        if (!isRecord(item) || typeof item.label !== 'string' || typeof item.description !== 'string') {
            return [];
        }
        return [{
            label: item.label,
            description: item.description,
        }];
    });
}

function asQuestionInfos(value: unknown): QuestionInfo[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((item) => {
        if (!isRecord(item) || typeof item.question !== 'string' || typeof item.header !== 'string') {
            return [];
        }
        return [{
            question: item.question,
            header: item.header,
            options: asQuestionOptions(item.options),
            ...(typeof item.multiple === 'boolean' ? { multiple: item.multiple } : {}),
            ...(typeof item.custom === 'boolean' ? { custom: item.custom } : {}),
        }];
    });
}

// ─── State types ─────────────────────────────────────────────────────────────

export interface SessionState {
    info: SessionInfo;
    messages: SessionMessage[];

    // Derived from metadata / messages by SyncNode
    permissions: PermissionRequest[];
    questions: QuestionRequest[];
    todos: Todo[];
    status: SessionStatus;
    runtimeConfig: RuntimeConfig | null;

    // ─── Session-level cache (Amendment 3) ──────────────────────────────
    // Typed fields extracted from metadata/agentState blobs. The app reads
    // these instead of reaching into the opaque blobs. Updated automatically
    // whenever metadata or agentState changes.
    lifecycleState: 'running' | 'idle' | 'archived' | 'archiveRequested';
    agentType?: string;
    modelID?: string;
    summary?: string;
    controlledByUser?: boolean;
    acpx?: SessionAcpxState | null;
    flow?: unknown;

    // Raw encrypted blobs (transport layer — kept for CAS updates)
    metadata: unknown;
    metadataVersion: number;
    agentState: unknown;
    agentStateVersion: number;
}

export type SessionStatus =
    | { type: 'idle' }
    | { type: 'running' }
    | { type: 'blocked'; reason: 'permission' | 'question' }
    | { type: 'completed' }
    | { type: 'error'; error: string };

export interface PermissionRequest {
    sessionId: SessionID;
    messageId: MessageID | null;
    callId: string;
    permissionId: string;
    block: PermissionBlock;
    resolved: boolean;
    decision?: 'once' | 'always' | 'reject';
    allowTools?: string[];
    reason?: string;
}

export interface QuestionRequest {
    sessionId: SessionID;
    messageId: MessageID | null;
    callId: string;
    questionId: string;
    block: QuestionBlock;
    resolved: boolean;
    answers?: string[][];
}

export interface SyncState {
    sessions: Map<string, SessionState>;
}

export interface PermissionBlock {
    type: 'permission';
    id: string;
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
}

export interface QuestionOption {
    label: string;
    description: string;
}

export interface QuestionInfo {
    question: string;
    header: string;
    options: QuestionOption[];
    multiple?: boolean;
    custom?: boolean;
}

export interface QuestionBlock {
    type: 'question';
    id: string;
    questions: QuestionInfo[];
}

// ─── Server message shape (what the HTTP API returns) ────────────────────────

const ServerMessageSchema = z.object({
    id: z.string(),
    seq: z.number().int(),
    content: z.unknown(),
    localId: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
});
type ServerMessage = z.infer<typeof ServerMessageSchema>;

const ServerMessagesResponseSchema = z.object({
    messages: z.array(ServerMessageSchema),
    hasMore: z.boolean().optional().default(false),
});

const ServerSessionSchema = z.object({
    id: z.string(),
    seq: z.number().int().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number().int().optional(),
    agentState: z.string().nullable().optional(),
    agentStateVersion: z.number().int().optional(),
    dataEncryptionKey: z.string().nullable().optional(),
    active: z.boolean().optional(),
    activeAt: z.number().optional(),
});

const ServerSessionsResponseSchema = z.object({
    sessions: z.array(ServerSessionSchema),
});

const CreateSessionResponseSchema = z.object({
    id: z.string().optional(),
    session: ServerSessionSchema.optional(),
});

const SocketNewMessageUpdateSchema = z.object({
    t: z.literal('new-message'),
    sid: z.string(),
    message: ServerMessageSchema,
});

const SocketNewSessionUpdateSchema = z.object({
    t: z.literal('new-session'),
    id: z.string(),
    seq: z.number().int().optional(),
    metadata: z.string(),
    metadataVersion: z.number().int().optional(),
    agentState: z.string().nullable().optional(),
    agentStateVersion: z.number().int().optional(),
    dataEncryptionKey: z.string().nullable().optional(),
    active: z.boolean().optional(),
    activeAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const SocketUpdateSessionValueSchema = z.object({
    value: z.string().nullable(),
    version: z.number().int(),
});

const SocketUpdateSessionUpdateSchema = z.object({
    t: z.literal('update-session'),
    id: z.string(),
    metadata: SocketUpdateSessionValueSchema.nullable().optional(),
    agentState: SocketUpdateSessionValueSchema.nullable().optional(),
});

const SocketDeleteSessionUpdateSchema = z.object({
    t: z.literal('delete-session'),
    sid: z.string(),
});

const SocketUpdateEnvelopeSchema = z.object({
    body: z.discriminatedUnion('t', [
        SocketNewMessageUpdateSchema,
        SocketNewSessionUpdateSchema,
        SocketUpdateSessionUpdateSchema,
        SocketDeleteSessionUpdateSchema,
    ]),
});

// ─── Outbox entry ────────────────────────────────────────────────────────────

interface OutboxEntry {
    sessionId: SessionID;
    localId: string;
    content: string; // encrypted base64
    resolve: () => void;
    reject: (err: Error) => void;
}

interface MessageInsertOpts {
    notifyListeners?: boolean;
}

interface FetchMessagesOpts extends MessageInsertOpts {
}

// ─── Create session options ──────────────────────────────────────────────────

export interface CreateSessionOpts {
    directory: string;
    projectID: string;
    title?: string;
    parentID?: SessionID;
}

export interface ApproveOpts {
    decision: 'once' | 'always';
    allowTools?: string[];
}

export interface DenyOpts {
    reason?: string;
}

export interface UsageReport {
    key: string;
    sessionId: string;
    tokens: {
        total: number;
        input: number;
        output: number;
        cache_creation: number;
        cache_read: number;
    };
    cost: {
        total: number;
        input: number;
        output: number;
    };
}

export type RpcHandler = (method: string, params: string) => Promise<string>;

// ─── Socket.IO typed events ─────────────────────────────────────────────────

interface SyncServerToClientEvents {
    update: (payload: unknown) => void;
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void;
}

interface MetadataCASResponse { result: string; metadata?: string; version?: number }
interface AgentStateCASResponse { result: string; agentState?: string | null; version?: number }

interface SyncClientToServerEvents {
    'session-alive': (data: { sid: string; time: number; thinking: boolean; mode: string }) => void;
    'session-end': (data: { sid: string; time: number }) => void;
    'usage-report': (report: UsageReport) => void;
    'rpc-register': (data: { methods: string[] }) => void;
    'update-metadata': (data: { sid: string; expectedVersion: number; metadata: string }, callback: (answer: MetadataCASResponse) => void) => void;
    'update-state': (data: { sid: string; expectedVersion: number; agentState: string | null }, callback: (answer: AgentStateCASResponse) => void) => void;
    'ping': (callback: () => void) => void;
}

export interface ResolveSessionKeyMaterialContext {
    sessionId: SessionID;
    encryptedDataKey: string | null;
    defaultKeyMaterial: KeyMaterial;
    claims: SyncNodeTokenClaims;
}

export type ResolveSessionKeyMaterial = (
    context: ResolveSessionKeyMaterialContext,
) => Promise<KeyMaterial | null | undefined> | KeyMaterial | null | undefined;

export interface SyncNodeOpts {
    resolveSessionKeyMaterial?: ResolveSessionKeyMaterial;
}

// ─── SyncNode class ──────────────────────────────────────────────────────────

export class SyncNode {
    readonly state: SyncState = { sessions: new Map() };

    private readonly token: SyncNodeToken;
    private readonly defaultKeyMaterial: KeyMaterial;
    private readonly resolveSessionKeyMaterial?: ResolveSessionKeyMaterial;
    private socket: Socket<SyncServerToClientEvents, SyncClientToServerEvents> | null = null;
    private outbox: OutboxEntry[] = [];
    private flushing = false;
    private stateListeners = new Set<(state: SyncState) => void>();
    private messageListeners = new Map<string, Set<(message: SessionMessage) => void>>();
    private sessionMessageListeners = new Map<string, Set<(message: SessionMessage) => void>>();
    private sessionLastSeq = new Map<string, number>();
    private sessionKeyMaterials = new Map<string, KeyMaterial>();
    private sessionEncryptedDataKeys = new Map<string, string | null>();
    private rpcHandler: RpcHandler | null = null;
    private metadataLocks = new Map<string, boolean>();
    private agentStateLocks = new Map<string, boolean>();
    private sessionMessageLocalIds = new WeakMap<object, string>();

    constructor(
        private readonly serverUrl: string,
        token: SyncNodeToken,
        keyMaterial: KeyMaterial,
        opts: SyncNodeOpts = {},
    ) {
        this.token = {
            raw: token.raw,
            claims: SyncNodeTokenClaimsSchema.parse(token.claims),
        };
        this.defaultKeyMaterial = keyMaterial;
        this.resolveSessionKeyMaterial = opts.resolveSessionKeyMaterial;
    }

    get claims(): SyncNodeTokenClaims {
        return this.token.claims;
    }

    hasPermission(permission: SyncNodeTokenClaims['permissions'][number]): boolean {
        return this.token.claims.permissions.includes(permission);
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    async connect(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.socket = io(this.serverUrl, {
                path: '/v1/updates',
                auth: this.buildSocketAuth(),
                transports: ['websocket'],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 10000,
                withCredentials: true,
            }) as Socket<SyncServerToClientEvents, SyncClientToServerEvents>;

            this.socket.on('connect', () => {
                resolve();
            });

            this.socket.on('connect_error', (err) => {
                reject(err);
            });

            // Listen for real-time update events from the server
            this.socket.on('update', (payload: unknown) => {
                this.handleServerUpdate(payload);
            });

            // RPC handler — server calls registered methods on this node
            this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
                if (this.rpcHandler) {
                    callback(await this.rpcHandler(data.method, data.params));
                } else {
                    callback(JSON.stringify({ error: 'no handler' }));
                }
            });

            this.socket.on('disconnect', () => {
                // Reconnection is handled automatically by socket.io-client
            });

            this.socket.io.on('reconnect', () => {
                // Re-hydrate state after reconnection
                void this.rehydrateAllSessions();
            });
        });

        if (this.token.claims.scope.type === 'account') {
            await this.fetchSessions();
        }
    }

    disconnect(): void {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }

    get connected(): boolean {
        return this.socket?.connected ?? false;
    }

    // ─── Session lifecycle signals ──────────────────────────────────────────

    /** Send a keepalive heartbeat for a session. */
    keepAlive(sessionId: SessionID, thinking: boolean, mode: 'local' | 'remote'): void {
        this.socket?.volatile.emit('session-alive', {
            sid: sessionId as string,
            time: Date.now(),
            thinking,
            mode,
        });
    }

    /** Signal that a session process has ended. */
    sendSessionDeath(sessionId: SessionID): void {
        void this.sendSessionEnd(sessionId, { reason: 'completed' });
        this.socket?.emit('session-end', {
            sid: sessionId as string,
            time: Date.now(),
        });
    }

    /** Send usage/cost data to the server. */
    sendUsageData(report: UsageReport): void {
        this.socket?.emit('usage-report', report);
    }

    /** Register an RPC handler for server-initiated calls. */
    setRpcHandler(handler: RpcHandler): void {
        this.rpcHandler = handler;
    }

    /** Register RPC methods with the server (e.g. 'abort', 'killSession'). */
    registerRpcMethods(methods: string[]): void {
        if (!this.socket) return;
        this.socket.emit('rpc-register', { methods });
    }

    /**
     * Update encrypted session metadata with CAS (compare-and-swap).
     * The handler receives the current metadata and returns the updated value.
     * Retries on version mismatch.
     */
    async updateMetadata<T = unknown>(
        sessionId: SessionID,
        handler: (current: T) => T,
    ): Promise<void> {
        if (!this.socket) throw new Error('Not connected');
        this.assertSessionAccess(sessionId);

        const key = sessionId as string;
        if (this.metadataLocks.get(key)) return; // Already updating
        this.metadataLocks.set(key, true);

        try {
            await this.casRetry(async () => {
                const session = this.state.sessions.get(key);
                if (!session) throw new Error(`Session ${sessionId} not found`);
                const keyMaterial = await this.getKeyMaterialForSession(sessionId);

                const updated = handler(session.metadata as T);
                const encrypted = encryptMessage(keyMaterial, {
                    session: this.sessionInfoToMetadata(session.info),
                    metadata: updated ?? null,
                });

                const answer = await this.socket!.emitWithAck('update-metadata', {
                    sid: sessionId as string,
                    expectedVersion: session.metadataVersion,
                    metadata: encrypted,
                });
                if (answer.result === 'success') {
                    if (answer.metadata) {
                        this.applyStoredMetadataUpdate(session, answer.metadata, Date.now(), keyMaterial);
                    } else {
                        session.metadata = updated;
                    }
                    session.metadataVersion = answer.version ?? session.metadataVersion + 1;
                    this.deriveMetadataCache(session);
                    this.deriveSessionState(session);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version && answer.version > session.metadataVersion) {
                        session.metadataVersion = answer.version;
                        if (answer.metadata) {
                            this.applyStoredMetadataUpdate(session, answer.metadata, Date.now(), keyMaterial);
                        }
                    }
                    this.deriveMetadataCache(session);
                    this.deriveSessionState(session);
                    throw new Error('Metadata version mismatch');
                }
                // 'error' result: silent ignore
            });
        } finally {
            this.metadataLocks.delete(key);
        }
    }

    /**
     * Update encrypted agent state with CAS (compare-and-swap).
     */
    async updateAgentState<T = unknown>(
        sessionId: SessionID,
        handler: (current: T) => T,
    ): Promise<void> {
        if (!this.socket) throw new Error('Not connected');
        this.assertSessionAccess(sessionId);

        const key = sessionId as string;
        if (this.agentStateLocks.get(key)) return;
        this.agentStateLocks.set(key, true);

        try {
            await this.casRetry(async () => {
                const session = this.state.sessions.get(key);
                if (!session) throw new Error(`Session ${sessionId} not found`);
                const keyMaterial = await this.getKeyMaterialForSession(sessionId);

                const updated = handler((session.agentState ?? {}) as T);
                const encrypted = updated
                    ? encryptMessage(keyMaterial, updated)
                    : null;

                const answer = await this.socket!.emitWithAck('update-state', {
                    sid: sessionId as string,
                    expectedVersion: session.agentStateVersion,
                    agentState: encrypted,
                });

                if (answer.result === 'success') {
                    session.agentState = answer.agentState
                        ? decryptMessage(keyMaterial, answer.agentState)
                        : updated;
                    session.agentStateVersion = answer.version ?? session.agentStateVersion + 1;
                    this.deriveMetadataCache(session);
                    this.deriveSessionState(session);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version && answer.version > session.agentStateVersion) {
                        session.agentStateVersion = answer.version;
                        if (answer.agentState) {
                            session.agentState = decryptMessage(keyMaterial, answer.agentState);
                        }
                    }
                    this.deriveMetadataCache(session);
                    this.deriveSessionState(session);
                    throw new Error('Agent state version mismatch');
                }
            });
        } finally {
            this.agentStateLocks.delete(key);
        }
    }

    /** Flush the outbox and wait for the socket buffer to drain. */
    async flush(sessionId?: SessionID): Promise<void> {
        await this.flushOutbox(sessionId);

        if (!this.socket?.connected) return;

        return new Promise<void>((resolve) => {
            this.socket!.emit('ping', () => resolve());
            setTimeout(resolve, 10000);
        });
    }

    // ─── Session operations (account-scoped only) ────────────────────────────

    async createSession(opts: CreateSessionOpts): Promise<SessionID> {
        this.assertAccountScoped('createSession');
        this.assertPermission('createSession', 'admin');

        const res = CreateSessionResponseSchema.parse(await this.httpPost('/v1/sessions', {
            directory: opts.directory,
            projectID: opts.projectID,
            title: opts.title ?? 'New Session',
            parentID: opts.parentID,
            dataEncryptionKey: Buffer.from(this.defaultKeyMaterial.key).toString('base64'),
        }));

        const sessionId = (res.id ?? res.session?.id) as SessionID | undefined;
        if (!sessionId) {
            throw new Error('Server did not return a session id');
        }

        // Initialize session state
        const info: SessionInfo = {
            id: sessionId,
            projectID: opts.projectID,
            directory: opts.directory,
            parentID: opts.parentID,
            title: opts.title ?? 'New Session',
            time: {
                created: Date.now(),
                updated: Date.now(),
            },
        };

        this.state.sessions.set(sessionId as string, this.createSessionState(info, {
            metadataVersion: res.session?.metadataVersion ?? 0,
            agentStateVersion: res.session?.agentStateVersion ?? 0,
        }));
        this.sessionKeyMaterials.set(sessionId as string, this.defaultKeyMaterial);
        this.sessionEncryptedDataKeys.set(sessionId as string, null);

        this.notifyStateChange();
        return sessionId;
    }

    listSessions(): SessionInfo[] {
        this.assertPermission('listSessions', 'read');

        const sessions = Array.from(this.state.sessions.values()).map((session) => session.info);
        const { scope } = this.token.claims;
        if (scope.type === 'session') {
            return sessions.filter((session) => session.id === scope.sessionId);
        }
        return sessions;
    }

    async fetchSessions(): Promise<SessionInfo[]> {
        this.assertAccountScoped('fetchSessions');
        this.assertPermission('fetchSessions', 'read');

        const response = ServerSessionsResponseSchema.parse(await this.httpGet('/v1/sessions'));
        for (const session of response.sessions) {
            const existing = this.state.sessions.get(session.id);
            const sessionId = SessionIDSchema.parse(session.id);
            this.rememberSessionEncryptedDataKey(sessionId, session.dataEncryptionKey ?? null);
            const keyMaterial = await this.getKeyMaterialForSession(sessionId, session.dataEncryptionKey ?? null);
            const decodedMetadata = this.decodeStoredSessionMetadata(session.metadata, keyMaterial);
            const info = this.toSessionInfo(session, decodedMetadata.sessionInfo, existing?.info);
            this.upsertSessionInfo(info, {
                metadata: decodedMetadata.metadata,
                metadataVersion: session.metadataVersion ?? 0,
                agentState: session.agentState
                    ? decryptMessage(keyMaterial, session.agentState) ?? null
                    : null,
                agentStateVersion: session.agentStateVersion ?? 0,
            });
        }

        return this.listSessions();
    }

    async stopSession(sessionId: SessionID): Promise<void> {
        this.assertAccountScoped('stopSession');
        this.assertPermission('stopSession', 'admin');

        const session = this.state.sessions.get(sessionId as string);
        if (session) {
            const pendingPermissionIds = session.permissions
                .filter((request) => !request.resolved)
                .map((request) => request.permissionId);

            for (const permissionId of pendingPermissionIds) {
                try {
                    await this.denyPermission(sessionId, permissionId, { reason: 'Session stopped' });
                } catch {
                    // Best-effort: the request may already have been resolved.
                }
            }

            try {
                await this.sendAbortRequest(sessionId, {
                    source: 'system',
                    reason: 'Session stopped',
                });
            } catch {
                // Best-effort: missing session key material should not block stop.
            }

            try {
                await this.sendSessionEnd(sessionId, { reason: 'killed' });
            } catch {
                // Best-effort: missing session key material should not block stop.
            }
        }

        await this.httpPost(`/v1/sessions/${sessionId}/stop`, {});

        if (session) {
            session.status = { type: 'completed' };
            this.notifyStateChange();
        }
    }

    // ─── Message operations ──────────────────────────────────────────────────

    async sendMessage(sessionId: SessionID, message: SessionMessage): Promise<void> {
        this.assertSessionAccess(sessionId);
        this.assertPermission('sendMessage', 'write');

        // Snapshot the message JSON before any async work to avoid races
        // where callers mutate the same object between yield points.
        const snapshot = JSON.stringify(message);
        const localId = this.getSessionMessageLocalId(message, true);

        const keyMaterial = await this.getKeyMaterialForSession(sessionId);
        const ciphertext = encryptMessage(keyMaterial, JSON.parse(snapshot));

        return new Promise<void>((resolve, reject) => {
            this.outbox.push({ sessionId, localId, content: ciphertext, resolve, reject });

            // Optimistically add to local state
            this.insertSessionMessage(sessionId, message, localId);

            this.flushOutbox(sessionId);
        });
    }

    async updateMessage(sessionId: SessionID, message: SessionMessage): Promise<void> {
        this.assertSessionAccess(sessionId);
        this.assertPermission('updateMessage', 'write');

        // Snapshot the message JSON before any async work to avoid races
        // where callers mutate the same object between yield points.
        const snapshot = JSON.stringify(message);
        const localId = this.getSessionMessageLocalId(message, false);

        const keyMaterial = await this.getKeyMaterialForSession(sessionId);
        const ciphertext = encryptMessage(keyMaterial, JSON.parse(snapshot));

        return new Promise<void>((resolve, reject) => {
            this.outbox.push({ sessionId, localId, content: ciphertext, resolve, reject });

            // Update local state immediately
            this.upsertMessage(sessionId, message);

            this.flushOutbox(sessionId);
        });
    }

    async sendRuntimeConfigChange(
        sessionId: SessionID,
        change: RuntimeConfig,
    ): Promise<void> {
        await this.updateMetadata<Record<string, unknown>>(sessionId, (current) => {
            const record = isRecord(current) ? current : {};
            const runtimeConfig = this.mergeRuntimeConfig(
                this.getRuntimeConfigFromMetadata(record),
                change,
            );
            return {
                ...record,
                runtimeConfig,
            };
        });
    }

    async sendAbortRequest(
        sessionId: SessionID,
        request: { source: string; reason: string },
    ): Promise<void> {
        await this.updateAgentState<Record<string, unknown>>(sessionId, (current) => ({
            ...(isRecord(current) ? current : {}),
            lastAbortRequest: {
                ...request,
                createdAt: Date.now(),
            },
        }));
    }

    async sendSessionEnd(
        sessionId: SessionID,
        sessionEnd: { reason: string },
    ): Promise<void> {
        await this.updateMetadata<Record<string, unknown>>(sessionId, (current) => ({
            ...(isRecord(current) ? current : {}),
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'sync-node',
            archiveReason: sessionEnd.reason,
        }));
    }

    async sendPermissionRequest(
        sessionId: SessionID,
        request: { callID: string; tool: string; patterns: string[]; input: Record<string, unknown> },
    ): Promise<void> {
        const permissionId = `perm_${createId()}`;
        await this.updateMetadata<Record<string, unknown>>(sessionId, (current) => {
            const record = isRecord(current) ? current : {};
            const pending = this.getPendingMetadata(record);
            const pendingBase = isRecord(record.pending) ? record.pending : {};
            return {
                ...record,
                pending: {
                    ...pendingBase,
                    permissions: [
                        ...pending.permissions,
                        {
                            id: permissionId,
                            callId: request.callID,
                            tool: request.tool,
                            patterns: request.patterns,
                            metadata: request.input,
                            resolved: false,
                        },
                    ],
                },
            };
        });
    }

    async approvePermission(
        sessionId: SessionID,
        requestId: string,
        opts: ApproveOpts = { decision: 'once' },
    ): Promise<void> {
        this.assertPermission('approvePermission', 'write');
        const request = this.findPermissionRequest(sessionId, requestId);
        if (!request) throw new Error(`Permission request ${requestId} not found`);
        await this.resolvePendingPermission(sessionId, request.permissionId, {
            decision: opts.decision,
            allowTools: opts.allowTools,
        });
    }

    async denyPermission(
        sessionId: SessionID,
        requestId: string,
        opts: DenyOpts = {},
    ): Promise<void> {
        this.assertPermission('denyPermission', 'write');
        const request = this.findPermissionRequest(sessionId, requestId);
        if (!request) throw new Error(`Permission request ${requestId} not found`);
        await this.resolvePendingPermission(sessionId, request.permissionId, {
            decision: 'reject',
            reason: opts.reason,
        });
    }

    async answerQuestion(
        sessionId: SessionID,
        questionId: string,
        answers: string[][],
    ): Promise<void> {
        this.assertPermission('answerQuestion', 'write');
        const request = this.findQuestionRequest(sessionId, questionId);
        if (!request) throw new Error(`Question request ${questionId} not found`);
        await this.resolvePendingQuestion(sessionId, request.questionId, answers);
    }

    // ─── Observation ─────────────────────────────────────────────────────────

    onStateChange(callback: (state: SyncState) => void): () => void {
        this.stateListeners.add(callback);
        return () => { this.stateListeners.delete(callback); };
    }

    onMessage(sessionId: SessionID, callback: (message: SessionMessage) => void): () => void {
        this.assertSessionAccess(sessionId);
        this.assertPermission('onMessage', 'read');
        const key = sessionId as string;
        if (!this.messageListeners.has(key)) {
            this.messageListeners.set(key, new Set());
        }
        this.messageListeners.get(key)!.add(callback);
        return () => { this.messageListeners.get(key)?.delete(callback); };
    }

    onSessionMessage(sessionId: SessionID, callback: (message: SessionMessage) => void): () => void {
        this.assertSessionAccess(sessionId);
        this.assertPermission('onSessionMessage', 'read');
        const key = sessionId as string;
        if (!this.sessionMessageListeners.has(key)) {
            this.sessionMessageListeners.set(key, new Set());
        }
        this.sessionMessageListeners.get(key)!.add(callback);
        return () => { this.sessionMessageListeners.get(key)?.delete(callback); };
    }

    // ─── Fetch / hydrate ─────────────────────────────────────────────────────

    async fetchMessages(
        sessionId: SessionID,
        afterSeq?: number,
        opts: FetchMessagesOpts = {},
    ): Promise<void> {
        this.assertSessionAccess(sessionId);
        this.assertPermission('fetchMessages', 'read');

        const params = new URLSearchParams();
        if (afterSeq !== undefined) params.set('after_seq', String(afterSeq));
        params.set('limit', '500');

        const url = `/v3/sessions/${sessionId}/messages?${params}`;
        const res = ServerMessagesResponseSchema.parse(await this.httpGet(url));
        const messages = res.messages;
        for (const serverMsg of messages) {
            await this.processServerMessage(sessionId, serverMsg, opts);
        }

        // Paginate if there are more
        if (res.hasMore && messages.length > 0) {
            const lastSeq = messages[messages.length - 1].seq;
            await this.fetchMessages(sessionId, lastSeq, opts);
        }
    }

    async flushOutbox(sessionId?: SessionID): Promise<void> {
        if (this.flushing || this.outbox.length === 0) return;
        this.flushing = true;

        const targetSessionId = sessionId
            ?? this.outbox[0]?.sessionId
            ?? (this.token.claims.scope.type === 'session' ? this.token.claims.scope.sessionId : undefined);

        if (!targetSessionId) {
            this.flushing = false;
            throw new Error('Cannot flush outbox without a session ID');
        }

        const batch: OutboxEntry[] = [];
        const remainder: OutboxEntry[] = [];
        for (const entry of this.outbox) {
            if (entry.sessionId === targetSessionId && batch.length < 100) {
                batch.push(entry);
            } else {
                remainder.push(entry);
            }
        }
        this.outbox = remainder;

        try {
            const res = await this.httpPost(`/v3/sessions/${targetSessionId}/messages`, {
                messages: batch.map(entry => ({
                    content: entry.content,
                    localId: entry.localId,
                })),
            });

            for (const entry of batch) {
                entry.resolve();
            }
        } catch (err) {
            for (const entry of batch) {
                entry.reject(err instanceof Error ? err : new Error(String(err)));
            }
        } finally {
            this.flushing = false;

            // Flush remaining entries if any
            if (this.outbox.length > 0) {
                this.flushOutbox(sessionId);
            }
        }
    }

    // ─── Internal: server update handling ────────────────────────────────────

    private handleServerUpdate(payload: unknown): void {
        const parsed = SocketUpdateEnvelopeSchema.safeParse(payload);
        if (!parsed.success) {
            return;
        }

        const { body } = parsed.data;

        switch (body.t) {
            case 'new-message':
                void this.processServerMessage(body.sid as SessionID, body.message);
                break;
            case 'new-session':
                void this.handleNewSessionUpdate(body);
                break;
            case 'update-session':
                void this.handleSessionUpdate(body);
                break;
            case 'delete-session':
                this.state.sessions.delete(body.sid);
                this.sessionLastSeq.delete(body.sid);
                this.sessionKeyMaterials.delete(body.sid);
                this.sessionEncryptedDataKeys.delete(body.sid);
                this.sessionMessageListeners.delete(body.sid);
                this.notifyStateChange();
                break;
        }
    }

    private async processServerMessage(
        sessionId: SessionID,
        serverMsg: ServerMessage,
        opts: MessageInsertOpts = {},
    ): Promise<void> {
        // Track seq for efficient reconnect/pagination
        const key = sessionId as string;
        const currentSeq = this.sessionLastSeq.get(key) ?? 0;
        if (serverMsg.seq > currentSeq) {
            this.sessionLastSeq.set(key, serverMsg.seq);
        }

        // Decrypt
        const content = serverMsg.content;
        let ciphertext: string;
        if (typeof content === 'string') {
            ciphertext = content;
        } else if (content && typeof content === 'object' && 't' in content && 'c' in content) {
            ciphertext = (content as { t: string; c: string }).c;
        } else {
            return; // Unknown content format
        }

        const keyMaterial = await this.getKeyMaterialForSession(sessionId);
        const decrypted = decryptMessage(keyMaterial, ciphertext);
        if (!isSessionMessage(decrypted)) return;

        this.insertSessionMessage(sessionId, decrypted, serverMsg.localId ?? `srv:${serverMsg.id}`, opts);
    }

    // ─── Internal: state management ──────────────────────────────────────────

    private ensureSession(sessionId: SessionID): SessionState {
        const key = sessionId as string;
        if (!this.state.sessions.has(key)) {
            this.state.sessions.set(key, this.createSessionState({
                id: sessionId,
                projectID: '',
                directory: '',
                title: `Session ${String(sessionId).slice(0, 8)}`,
                time: { created: Date.now(), updated: Date.now() },
            }));
        }
        return this.state.sessions.get(key)!;
    }

    private createSessionState(info: SessionInfo, opts?: {
        metadata?: unknown;
        metadataVersion?: number;
        agentState?: unknown;
        agentStateVersion?: number;
    }): SessionState {
        const session: SessionState = {
            info,
            messages: [],
            permissions: [],
            questions: [],
            todos: [],
            status: { type: 'idle' },
            runtimeConfig: null,
            lifecycleState: 'running',
            metadata: opts?.metadata ?? null,
            metadataVersion: opts?.metadataVersion ?? 0,
            agentState: opts?.agentState ?? null,
            agentStateVersion: opts?.agentStateVersion ?? 0,
        };
        this.deriveMetadataCache(session);
        this.deriveSessionState(session);
        return session;
    }

    private upsertSessionInfo(info: SessionInfo, opts?: {
        metadata?: unknown;
        metadataVersion?: number;
        agentState?: unknown;
        agentStateVersion?: number;
    }): void {
        const key = info.id as string;
        const existing = this.state.sessions.get(key);
        if (!existing) {
            this.state.sessions.set(key, this.createSessionState(info, opts));
            this.notifyStateChange();
            return;
        }

        existing.info = info;
        if (opts) {
            if (opts.metadata !== undefined) existing.metadata = opts.metadata;
            if (opts.metadataVersion !== undefined) existing.metadataVersion = opts.metadataVersion;
            if (opts.agentState !== undefined) existing.agentState = opts.agentState;
            if (opts.agentStateVersion !== undefined) existing.agentStateVersion = opts.agentStateVersion;
        }
        this.deriveMetadataCache(existing);
        this.deriveSessionState(existing);
        this.notifyStateChange();
    }

    /**
     * Extract typed session-level cache fields from the opaque metadata and
     * agentState blobs. Called after any metadata/agentState update so that
     * consumers can read typed fields directly from SessionState instead of
     * reaching into the encrypted blobs.
     */
    private deriveMetadataCache(session: SessionState): void {
        const meta = isRecord(session.metadata) ? session.metadata : null;
        if (meta) {
            // Lifecycle
            const lcs = meta.lifecycleState;
            if (lcs === 'running' || lcs === 'idle' || lcs === 'archived' || lcs === 'archiveRequested') {
                session.lifecycleState = lcs;
            }

            // Agent type (metadata calls it "flavor")
            if (typeof meta.flavor === 'string') {
                session.agentType = meta.flavor;
            }

            // Model
            if (typeof meta.currentModelCode === 'string') {
                session.modelID = meta.currentModelCode;
            }
            if (isRecord(meta.acpx)) {
                session.acpx = meta.acpx as SessionAcpxState;
                if (typeof meta.acpx.current_model_id === 'string') {
                    session.modelID = meta.acpx.current_model_id;
                }
            }
            if (meta.flow !== undefined) {
                session.flow = meta.flow;
            }

            // Summary
            const summary = meta.summary;
            if (isRecord(summary)) {
                const text = summary.text;
                if (typeof text === 'string') {
                    session.summary = text;
                }
            }
        }

        // controlledByUser from agentState
        const state = isRecord(session.agentState) ? session.agentState : null;
        if (state && 'controlledByUser' in state) {
            session.controlledByUser = state.controlledByUser as boolean | undefined;
        }
    }

    insertMessage(
        sessionId: SessionID,
        message: SessionMessage,
        messageKey?: string,
        opts: MessageInsertOpts = {},
    ): void {
        this.insertSessionMessage(sessionId, message, messageKey, opts);
    }

    private insertSessionMessage(
        sessionId: SessionID,
        message: SessionMessage,
        messageKey?: string,
        opts: MessageInsertOpts = {},
    ): void {
        const session = this.ensureSession(sessionId);
        const storageKey = messageKey ?? this.getSessionMessageLocalId(message, true);
        if (typeof message === 'object' && message !== null) {
            this.sessionMessageLocalIds.set(message, storageKey);
        }
        const existingIdx = session.messages.findIndex((existing) => {
            try {
                return this.getSessionMessageLocalId(existing, false) === storageKey;
            } catch {
                return false;
            }
        });
        if (existingIdx >= 0) {
            session.messages[existingIdx] = message;
        } else {
            session.messages.push(message);
        }

        this.deriveSessionState(session);
        this.notifyStateChange();
        if (opts.notifyListeners !== false) {
            this.notifySessionMessageListeners(sessionId, message);
            this.notifyMessageListeners(sessionId, message);
        }
    }

    upsertMessage(sessionId: SessionID, message: SessionMessage): void {
        this.insertMessage(sessionId, message);
    }

    private deriveSessionState(session: SessionState): void {
        let latestTodos: Todo[] | undefined;
        const metadata = isRecord(session.metadata) ? session.metadata : null;
        const pending = this.getPendingMetadata(metadata);

        session.runtimeConfig = metadata ? this.getRuntimeConfigFromMetadata(metadata) : null;
        session.permissions = pending.permissions.map((permission) => ({
            sessionId: session.info.id,
            messageId: permission.messageId ? MessageIDSchema.parse(permission.messageId) : null,
            callId: permission.callId,
            permissionId: permission.id,
            block: {
                type: 'permission' as const,
                id: permission.id,
                permission: permission.tool,
                patterns: permission.patterns,
                always: permission.allowTools ?? [],
                metadata: permission.metadata,
            },
            resolved: permission.resolved === true || permission.decision !== undefined,
            decision: permission.decision,
            allowTools: permission.allowTools,
            reason: permission.reason,
        }));
        session.questions = pending.questions.map((question) => ({
            sessionId: session.info.id,
            messageId: question.messageId ? MessageIDSchema.parse(question.messageId) : null,
            callId: question.callId,
            questionId: question.id,
            block: {
                type: 'question' as const,
                id: question.id,
                questions: question.questions,
            },
            resolved: question.resolved === true || Array.isArray(question.answers),
            answers: question.answers,
        }));

        for (const msg of session.messages) {
            const derivedTodos = this.extractTodosFromMessage(msg);
            if (derivedTodos !== undefined) {
                latestTodos = derivedTodos;
            }
        }

        session.todos = latestTodos ?? [];

        if (session.permissions.some((permission) => !permission.resolved)) {
            session.status = { type: 'blocked', reason: 'permission' };
            return;
        }

        if (session.questions.some((question) => !question.resolved)) {
            session.status = { type: 'blocked', reason: 'question' };
            return;
        }

        if (session.lifecycleState === 'archived') {
            const metadataRecord = isRecord(session.metadata) ? session.metadata : null;
            const archiveReason = metadataRecord && typeof metadataRecord.archiveReason === 'string'
                ? metadataRecord.archiveReason
                : null;
            session.status = archiveReason === 'crashed'
                ? { type: 'error', error: 'Session crashed' }
                : { type: 'completed' };
            return;
        }

        if (session.lifecycleState === 'running' || session.lifecycleState === 'archiveRequested') {
            session.status = { type: 'running' };
            return;
        }

        session.status = { type: 'idle' };
    }

    private mergeRuntimeConfig(
        current: RuntimeConfig | null,
        next: RuntimeConfig,
    ): RuntimeConfig {
        if (!current) {
            return next;
        }

        const merged: RuntimeConfig = {
            ...current,
            source: next.source,
        };

        if (Object.prototype.hasOwnProperty.call(next, 'permissionMode')) {
            merged.permissionMode = next.permissionMode;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'model')) {
            merged.model = next.model;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'fallbackModel')) {
            merged.fallbackModel = next.fallbackModel;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'customSystemPrompt')) {
            merged.customSystemPrompt = next.customSystemPrompt;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'appendSystemPrompt')) {
            merged.appendSystemPrompt = next.appendSystemPrompt;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'allowedTools')) {
            merged.allowedTools = next.allowedTools;
        }
        if (Object.prototype.hasOwnProperty.call(next, 'disallowedTools')) {
            merged.disallowedTools = next.disallowedTools;
        }

        return merged;
    }

    private extractTodosFromMessage(message: SessionMessage): Todo[] | undefined {
        if (!isSessionAgentMessage(message)) {
            return undefined;
        }

        for (const content of message.Agent.content) {
            if (!('ToolUse' in content) || !this.isTodoTool(content.ToolUse.name)) {
                continue;
            }

            const fromInput = this.extractTodosFromUnknown(content.ToolUse.input);
            if (fromInput !== undefined) {
                return fromInput;
            }

            const fromResult = this.extractTodosFromToolResult(message.Agent.tool_results[content.ToolUse.id]);
            if (fromResult !== undefined) {
                return fromResult;
            }
        }

        return undefined;
    }

    private extractTodosFromToolResult(result: SessionToolResult | undefined): Todo[] | undefined {
        if (!result) {
            return undefined;
        }

        const fromOutput = this.extractTodosFromUnknown(result.output);
        if (fromOutput !== undefined) {
            return fromOutput;
        }

        if ('Text' in result.content) {
            return this.extractTodosFromUnknown(this.parseJson(result.content.Text));
        }

        return undefined;
    }

    private extractTodosFromUnknown(value: unknown): Todo[] | undefined {
        if (!value) {
            return undefined;
        }

        const candidates: unknown[] = [];
        if (Array.isArray(value)) {
            candidates.push(value);
        }

        if (value && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            if ('todos' in record) {
                candidates.push(record.todos);
            }
            if ('newTodos' in record) {
                candidates.push(record.newTodos);
            }
        }

        for (const candidate of candidates) {
            if (!Array.isArray(candidate)) {
                continue;
            }

            const todos = candidate
                .map((item) => this.normalizeTodo(item))
                .filter((item): item is Todo => item !== null);
            return todos;
        }

        return undefined;
    }

    private normalizeTodo(value: unknown): Todo | null {
        if (!value || typeof value !== 'object') {
            return null;
        }

        const record = value as Record<string, unknown>;
        const parsed = TodoSchema.safeParse({
            content: record.content,
            status: record.status,
            priority: typeof record.priority === 'string' ? record.priority : 'medium',
        });
        return parsed.success ? parsed.data : null;
    }

    private isTodoTool(toolName: string): boolean {
        const normalized = toolName.trim().toLowerCase();
        return normalized === 'todowrite' || normalized === 'todo_write' || normalized === 'todo-write';
    }

    // ─── Internal: helpers ───────────────────────────────────────────────────

    private findPermissionRequest(sessionId: SessionID, requestId: string): PermissionRequest | undefined {
        const session = this.state.sessions.get(sessionId as string);
        return session?.permissions.find((p) =>
            p.permissionId === requestId
            || p.callId === requestId,
        );
    }

    private findQuestionRequest(sessionId: SessionID, questionId: string): QuestionRequest | undefined {
        const session = this.state.sessions.get(sessionId as string);
        return session?.questions.find(q => q.questionId === questionId);
    }

    private notifyStateChange(): void {
        for (const listener of this.stateListeners) {
            listener(this.state);
        }
    }

    private notifyMessageListeners(sessionId: SessionID, message: SessionMessage): void {
        const listeners = this.messageListeners.get(sessionId as string);
        if (listeners) {
            for (const listener of listeners) {
                listener(message);
            }
        }
    }

    private notifySessionMessageListeners(sessionId: SessionID, message: SessionMessage): void {
        const listeners = this.sessionMessageListeners.get(sessionId as string);
        if (listeners) {
            for (const listener of listeners) {
                listener(message);
            }
        }
    }

    private getSessionMessageLocalId(message: SessionMessage, createIfMissing: boolean): string {
        if (message === 'Resume') {
            if (!createIfMissing) {
                return 'resume';
            }
            return `resume:${createId()}`;
        }

        const existing = this.sessionMessageLocalIds.get(message);
        if (existing) {
            return existing;
        }

        if (isSessionUserMessage(message)) {
            return `user:${message.User.id}`;
        }

        if (!createIfMissing) {
            throw new Error('Agent message does not have a local id yet');
        }
        const localId = `agent:${createId()}`;
        this.sessionMessageLocalIds.set(message, localId);
        return localId;
    }

    private getPendingMetadata(metadata: Record<string, unknown> | null): {
        permissions: PendingPermissionMetadata[];
        questions: PendingQuestionMetadata[];
    } {
        const pending = metadata && isRecord(metadata.pending) ? metadata.pending : null;
        const permissions = Array.isArray(pending?.permissions)
            ? pending.permissions
                .map((value) => this.parsePendingPermissionMetadata(value))
                .filter((value): value is PendingPermissionMetadata => value !== null)
            : [];
        const questions = Array.isArray(pending?.questions)
            ? pending.questions
                .map((value) => this.parsePendingQuestionMetadata(value))
                .filter((value): value is PendingQuestionMetadata => value !== null)
            : [];
        return { permissions, questions };
    }

    private parsePendingPermissionMetadata(value: unknown): PendingPermissionMetadata | null {
        if (!isRecord(value)) {
            return null;
        }

        const id = typeof value.id === 'string'
            ? value.id
            : typeof value.permissionId === 'string'
                ? value.permissionId
                : null;
        const callId = typeof value.callId === 'string'
            ? value.callId
            : typeof value.callID === 'string'
                ? value.callID
                : id;
        const tool = typeof value.tool === 'string'
            ? value.tool
            : typeof value.permission === 'string'
                ? value.permission
                : null;

        if (!id || !callId || !tool) {
            return null;
        }

        return {
            id,
            callId,
            ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
            tool,
            patterns: asStringArray(value.patterns),
            metadata: isRecord(value.metadata)
                ? value.metadata
                : isRecord(value.input)
                    ? value.input
                    : {},
            ...(asStringArray(value.allowTools).length > 0 ? { allowTools: asStringArray(value.allowTools) } : {}),
            ...(value.decision === 'once' || value.decision === 'always' || value.decision === 'reject'
                ? { decision: value.decision }
                : {}),
            ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
            ...(typeof value.resolved === 'boolean' ? { resolved: value.resolved } : {}),
        };
    }

    private parsePendingQuestionMetadata(value: unknown): PendingQuestionMetadata | null {
        if (!isRecord(value)) {
            return null;
        }

        const id = typeof value.id === 'string'
            ? value.id
            : typeof value.questionId === 'string'
                ? value.questionId
                : null;
        const callId = typeof value.callId === 'string'
            ? value.callId
            : typeof value.callID === 'string'
                ? value.callID
                : id;
        const questions = asQuestionInfos(value.questions);
        if (!id || !callId || questions.length === 0) {
            return null;
        }

        const answers = Array.isArray(value.answers)
            ? value.answers.map((answer) => Array.isArray(answer) ? answer.filter((item): item is string => typeof item === 'string') : [])
            : undefined;

        return {
            id,
            callId,
            ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
            questions,
            ...(answers ? { answers } : {}),
            ...(typeof value.resolved === 'boolean' ? { resolved: value.resolved } : {}),
        };
    }

    private getRuntimeConfigFromMetadata(metadata: Record<string, unknown>): RuntimeConfig | null {
        const candidate = isRecord(metadata.runtimeConfig) ? metadata.runtimeConfig : metadata;
        const runtimeConfig: RuntimeConfig = {
            source: typeof candidate.source === 'string' ? candidate.source : 'user',
        };
        let hasConfig = false;

        for (const key of ['permissionMode', 'model', 'fallbackModel', 'customSystemPrompt', 'appendSystemPrompt']) {
            if (Object.prototype.hasOwnProperty.call(candidate, key)) {
                runtimeConfig[key as keyof RuntimeConfig] = candidate[key] as never;
                hasConfig = true;
            }
        }
        if (Object.prototype.hasOwnProperty.call(candidate, 'allowedTools')) {
            runtimeConfig.allowedTools = Array.isArray(candidate.allowedTools) ? asStringArray(candidate.allowedTools) : null;
            hasConfig = true;
        }
        if (Object.prototype.hasOwnProperty.call(candidate, 'disallowedTools')) {
            runtimeConfig.disallowedTools = Array.isArray(candidate.disallowedTools) ? asStringArray(candidate.disallowedTools) : null;
            hasConfig = true;
        }

        return hasConfig ? runtimeConfig : null;
    }

    private async resolvePendingPermission(
        sessionId: SessionID,
        permissionId: string,
        resolution: { decision: 'once' | 'always' | 'reject'; allowTools?: string[]; reason?: string },
    ): Promise<void> {
        await this.updateMetadata<Record<string, unknown>>(sessionId, (current) => {
            const record = isRecord(current) ? current : {};
            const pending = this.getPendingMetadata(record);
            const pendingBase = isRecord(record.pending) ? record.pending : {};
            return {
                ...record,
                pending: {
                    ...pendingBase,
                    permissions: pending.permissions.map((permission) =>
                        permission.id !== permissionId
                            ? permission
                            : {
                                ...permission,
                                decision: resolution.decision,
                                allowTools: resolution.allowTools,
                                reason: resolution.reason,
                                resolved: true,
                            },
                    ),
                    questions: pending.questions,
                },
            };
        });
    }

    private async resolvePendingQuestion(
        sessionId: SessionID,
        questionId: string,
        answers: string[][],
    ): Promise<void> {
        await this.updateMetadata<Record<string, unknown>>(sessionId, (current) => {
            const record = isRecord(current) ? current : {};
            const pending = this.getPendingMetadata(record);
            const pendingBase = isRecord(record.pending) ? record.pending : {};
            return {
                ...record,
                pending: {
                    ...pendingBase,
                    permissions: pending.permissions,
                    questions: pending.questions.map((question) =>
                        question.id !== questionId
                            ? question
                            : {
                                ...question,
                                answers,
                                resolved: true,
                            },
                    ),
                },
            };
        });
    }

    private rememberSessionEncryptedDataKey(sessionId: SessionID, encryptedDataKey: string | null): void {
        this.sessionEncryptedDataKeys.set(sessionId as string, encryptedDataKey);
    }

    private async getKeyMaterialForSession(
        sessionId: SessionID,
        encryptedDataKey?: string | null,
    ): Promise<KeyMaterial> {
        const key = sessionId as string;
        const cached = this.sessionKeyMaterials.get(key);
        if (cached) {
            return cached;
        }

        let knownEncryptedDataKey: string | null = null;
        if (encryptedDataKey !== undefined) {
            knownEncryptedDataKey = encryptedDataKey;
            this.rememberSessionEncryptedDataKey(sessionId, encryptedDataKey);
        } else if (this.sessionEncryptedDataKeys.has(key)) {
            knownEncryptedDataKey = this.sessionEncryptedDataKeys.get(key) ?? null;
        }

        if (this.resolveSessionKeyMaterial) {
            const resolved = await this.resolveSessionKeyMaterial({
                sessionId,
                encryptedDataKey: knownEncryptedDataKey,
                defaultKeyMaterial: this.defaultKeyMaterial,
                claims: this.token.claims,
            });
            if (resolved) {
                this.sessionKeyMaterials.set(key, resolved);
                return resolved;
            }
        }

        this.sessionKeyMaterials.set(key, this.defaultKeyMaterial);
        return this.defaultKeyMaterial;
    }

    private async handleNewSessionUpdate(
        body: z.infer<typeof SocketNewSessionUpdateSchema>,
    ): Promise<void> {
        const sessionId = SessionIDSchema.parse(body.id);
        this.rememberSessionEncryptedDataKey(sessionId, body.dataEncryptionKey ?? null);
        const keyMaterial = await this.getKeyMaterialForSession(sessionId, body.dataEncryptionKey ?? null);
        const decodedMetadata = this.decodeStoredSessionMetadata(body.metadata, keyMaterial);
        this.upsertSessionInfo(
            this.toSessionInfo({
                id: body.id,
                createdAt: body.createdAt,
                updatedAt: body.updatedAt,
            }, decodedMetadata.sessionInfo, this.state.sessions.get(body.id)?.info),
            {
                metadata: decodedMetadata.metadata,
                metadataVersion: body.metadataVersion ?? 0,
                agentState: body.agentState
                    ? decryptMessage(keyMaterial, body.agentState) ?? null
                    : null,
                agentStateVersion: body.agentStateVersion ?? 0,
            },
        );
    }

    private async handleSessionUpdate(
        body: z.infer<typeof SocketUpdateSessionUpdateSchema>,
    ): Promise<void> {
        const sessionId = SessionIDSchema.parse(body.id);
        const current = this.state.sessions.get(sessionId as string);
        if (!current) {
            return;
        }

        const keyMaterial = await this.getKeyMaterialForSession(sessionId);
        let changed = false;

        if (body.metadata && body.metadata.version > current.metadataVersion) {
            current.metadataVersion = body.metadata.version;
            if (body.metadata.value) {
                this.applyStoredMetadataUpdate(current, body.metadata.value, Date.now(), keyMaterial);
            } else {
                current.metadata = null;
            }
            changed = true;
        }

        if (body.agentState && body.agentState.version > current.agentStateVersion) {
            current.agentStateVersion = body.agentState.version;
            current.agentState = body.agentState.value
                ? decryptMessage(keyMaterial, body.agentState.value) ?? null
                : null;
            changed = true;
        }

        if (changed) {
            this.deriveMetadataCache(current);
            this.deriveSessionState(current);
            this.notifyStateChange();
        }
    }

    private assertAccountScoped(operation: string): void {
        if (this.token.claims.scope.type !== 'account') {
            throw new Error(`${operation} requires account-scoped token`);
        }
    }

    private assertPermission(operation: string, permission: SyncNodeTokenClaims['permissions'][number]): void {
        if (!this.hasPermission(permission)) {
            throw new Error(`${operation} requires ${permission} permission`);
        }
    }

    private assertSessionAccess(sessionId: SessionID): void {
        const scope = this.token.claims.scope;
        if (scope.type === 'session' && scope.sessionId !== (sessionId as string)) {
            throw new Error(`Session-scoped token cannot access session ${sessionId}`);
        }
    }

    private buildSocketAuth(): Record<string, unknown> {
        const scope = this.token.claims.scope;
        if (scope.type === 'session') {
            return {
                token: this.token.raw,
                clientType: 'session-scoped',
                sessionId: scope.sessionId,
            };
        }

        return {
            token: this.token.raw,
            clientType: 'user-scoped',
        };
    }

    /** Retry an async operation with exponential backoff (for CAS loops). */
    private async casRetry(fn: () => Promise<void>, maxAttempts = 5): Promise<void> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                await fn();
                return;
            } catch {
                if (attempt === maxAttempts - 1) return; // Give up silently after max retries
                await new Promise(r => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)));
            }
        }
    }

    private async rehydrateAllSessions(): Promise<void> {
        try {
            let knownSessionIds: Set<string> | null = null;

            if (this.token.claims.scope.type === 'account') {
                const sessions = await this.fetchSessions();
                knownSessionIds = new Set(sessions.map(session => session.id as string));
            }

            for (const [sessionIdStr] of [...this.state.sessions]) {
                if (knownSessionIds && !knownSessionIds.has(sessionIdStr)) {
                    this.dropLocalSession(sessionIdStr);
                    continue;
                }

                const sessionId = sessionIdStr as SessionID;
                const session = this.state.sessions.get(sessionIdStr);
                if (!session) continue;

                const lastSeq = this.getLastSeq(session);
                try {
                    await this.fetchMessages(sessionId, lastSeq);
                } catch (error) {
                    if (this.isNotFoundError(error)) {
                        this.dropLocalSession(sessionIdStr);
                        continue;
                    }
                    console.warn(`[SyncNode] Failed to rehydrate session ${sessionIdStr}`, error);
                }
            }
        } catch (error) {
            console.warn('[SyncNode] Failed to rehydrate sessions after reconnect', error);
        }
    }

    private dropLocalSession(sessionIdStr: string): void {
        this.state.sessions.delete(sessionIdStr);
        this.sessionLastSeq.delete(sessionIdStr);
        this.sessionKeyMaterials.delete(sessionIdStr);
        this.sessionEncryptedDataKeys.delete(sessionIdStr);
        this.sessionMessageListeners.delete(sessionIdStr);
        this.notifyStateChange();
    }

    private isNotFoundError(error: unknown): boolean {
        return error instanceof Error
            && /HTTP GET .* failed: 404\b/.test(error.message);
    }

    private getLastSeq(session: SessionState): number {
        return this.sessionLastSeq.get(session.info.id as string) ?? 0;
    }

    /** Expose last known seq for a session (for testing and reconnect logic) */
    getSessionLastSeq(sessionId: SessionID): number {
        return this.sessionLastSeq.get(sessionId as string) ?? 0;
    }

    // ─── HTTP helpers ────────────────────────────────────────────────────────

    private async httpGet(path: string): Promise<Record<string, unknown>> {
        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.token.raw}`,
                'Content-Type': 'application/json',
            },
        });
        if (!res.ok) {
            throw new Error(`HTTP GET ${path} failed: ${res.status} ${res.statusText}`);
        }
        return res.json() as Promise<Record<string, unknown>>;
    }

    private async httpPost(path: string, body: unknown): Promise<Record<string, unknown>> {
        const url = `${this.serverUrl}${path}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token.raw}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`HTTP POST ${path} failed: ${res.status} ${res.statusText}`);
        }
        return res.json() as Promise<Record<string, unknown>>;
    }

    private toSessionInfo(session: {
        id: string;
        createdAt: number;
        updatedAt: number;
    }, parsedMetadata: SyncNodeSessionMetadata | null, fallback?: SessionInfo): SessionInfo {
        return {
            id: SessionIDSchema.parse(session.id),
            projectID: parsedMetadata?.projectID ?? fallback?.projectID ?? '',
            directory: parsedMetadata?.directory ?? fallback?.directory ?? '',
            parentID: parsedMetadata
                ? (parsedMetadata.parentID ? SessionIDSchema.parse(parsedMetadata.parentID) : undefined)
                : fallback?.parentID,
            title: parsedMetadata?.title ?? fallback?.title ?? `Session ${session.id.slice(0, 8)}`,
            time: {
                created: fallback?.time.created ?? session.createdAt,
                updated: session.updatedAt,
            },
        };
    }

    private sessionInfoToMetadata(info: SessionInfo): SyncNodeSessionMetadata {
        return {
            directory: info.directory,
            projectID: info.projectID,
            title: info.title,
            parentID: info.parentID ?? null,
        };
    }

    private applyStoredMetadataUpdate(
        session: SessionState,
        metadata: string,
        updatedAt: number,
        keyMaterial: KeyMaterial,
    ): void {
        const decoded = this.decodeStoredSessionMetadata(metadata, keyMaterial);
        session.metadata = decoded.metadata;
        session.info = this.toSessionInfo({
            id: session.info.id,
            createdAt: session.info.time.created,
            updatedAt,
        }, decoded.sessionInfo, session.info);
    }

    private decodeStoredSessionMetadata(
        metadata: string,
        keyMaterial: KeyMaterial = this.defaultKeyMaterial,
    ): { sessionInfo: SyncNodeSessionMetadata | null; metadata: unknown } {
        const parsedPlaintext = this.parseStoredSessionMetadataValue(this.parseJson(metadata));
        if (parsedPlaintext) {
            return parsedPlaintext;
        }

        const decrypted = decryptMessage(keyMaterial, metadata);
        const parsedEncrypted = this.parseStoredSessionMetadataValue(decrypted);
        if (parsedEncrypted) {
            return parsedEncrypted;
        }

        return {
            sessionInfo: null,
            metadata: decrypted ?? null,
        };
    }

    private parseStoredSessionMetadataValue(value: unknown): { sessionInfo: SyncNodeSessionMetadata | null; metadata: unknown } | null {
        const envelope = SyncNodeStoredSessionMetadataSchema.safeParse(value);
        if (envelope.success) {
            return {
                sessionInfo: envelope.data.session,
                metadata: envelope.data.metadata ?? null,
            };
        }

        const sessionMetadata = SyncNodeSessionMetadataSchema.safeParse(value);
        if (sessionMetadata.success) {
            return {
                sessionInfo: sessionMetadata.data,
                metadata: null,
            };
        }

        return null;
    }

    private parseJson(value: string): unknown | null {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
}
