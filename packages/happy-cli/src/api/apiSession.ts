import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, FileEventMessage, FileEventMessageSchema, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decryptBlob, decrypt, encodeBase64, encrypt, encryptBlob } from './encryption';
import type { StreamDeltaFrame } from '@/claude/streamDeltaRelay';
import type { ClaudeTurnLatencyDiagnostic } from '@/claude/claudeRemote';
import { backoff, delay, isSessionGoneError } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { deriveKey } from '@/utils/deriveKey';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { createRpcRequestListener } from './rpc/rpcRequestListener';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import { shouldReconnect } from '@/utils/lidState';
import { RECONNECT_DIAL_TIMEOUT_MS, RECONNECT_NOT_READY_POLL_MS, reconnectDelayMs } from '@/api/reconnectCadence';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope, type SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeChannelFinalAnswer,
    mapClaudeLogMessageToSessionEnvelopes,
    toolCallTurnFor,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import { notifyDaemonSessionRuntime } from '@/daemon/controlClient';
import axios from 'axios';
import {
    ProviderUsageEventV1Schema,
    type ProviderUsageEventV1,
} from '@slopus/happy-wire';
import { ClaudeTurnUsageTracker } from '@/usage/claudeTurnUsage';
import { createClaudeTurnUsageEvent, createClaudeUsageEvent } from '@/usage/providerUsageAdapters';
import type { ObservedAiAuthSource } from '@/claude/aiAuthObservation';

const DAEMON_RUNTIME_REPORT_MAX_INTERVAL_MS = 30_000;

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

type V3SessionMessage = {
    id: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

type V3GetSessionMessagesResponse = {
    messages: V3SessionMessage[];
    hasMore: boolean;
};

type V3GetSessionEventsResponse = {
    events: Array<{
        id: string;
        eventType: string;
        seq: number;
        content: unknown;
        createdAt: number;
        updatedAt: number;
    }>;
    hasMore: boolean;
};

type V2SessionLookupResponse = {
    sessions: Array<{
        id: string;
        active: boolean;
    }>;
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

/**
 * Outcome of waiting for one message to be durably acknowledged.
 *
 * `ok: false` means the acknowledgement was not observed — **not** that the
 * message was lost. A 2xx whose body omits our row leaves durability unknown,
 * and a caller must treat it as "do not proceed", never as "it is gone".
 */
export type MessageAckOutcome =
    | { ok: true; id: string; seq: number }
    | { ok: false; reason: 'deadline' | 'closed' | 'sync-failed' | 'contradictory-ack' };

/**
 * Whether a server row is a usable acknowledgement for `localId`.
 *
 * Exported for the exhaustive shape tests; kept in this file because the
 * acknowledgement map that consumes it is a concern of this class and moving
 * one predicate out would not give it a second owner.
 */
export function readMessageAck(
    rows: unknown,
    localId: string,
): { ok: true; id: string; seq: number } | { ok: false; reason: 'absent' | 'contradictory-ack' } {
    // The body is network input: the declared type is a hope, not a guarantee.
    if (!Array.isArray(rows)) return { ok: false, reason: 'absent' };
    const matches = rows.filter((row) => (
        row !== null && typeof row === 'object'
        && (row as { localId?: unknown }).localId === localId
    )) as Array<{ id?: unknown; seq?: unknown }>;
    if (matches.length === 0) return { ok: false, reason: 'absent' };

    const usable = matches.filter((row) => (
        typeof row.id === 'string' && row.id.length > 0
        && typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq > 0
    )) as Array<{ id: string; seq: number }>;
    // A malformed row alongside a well-formed one is not a clean answer: the
    // server is describing our localId twice and we cannot tell which is ours.
    // Picking the valid one would turn an inconsistent response into a
    // confirmation.
    if (usable.length !== matches.length) return { ok: false, reason: 'contradictory-ack' };

    const first = usable[0]!;
    if (usable.some((row) => row.id !== first.id || row.seq !== first.seq)) {
        return { ok: false, reason: 'contradictory-ack' };
    }
    return { ok: true, id: first.id, seq: first.seq };
}

type AttachmentUploadResult = {
    ref: string;
    uploadUrl: string;
    method?: 'PUT' | 'POST';
    formFields?: Record<string, string>;
};

export type LocalImageAttachment = {
    data: Uint8Array;
    mimeType: string;
    name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function extensionForImageMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        case 'image/png':
        default:
            return 'png';
    }
}

function isAskUserQuestionToolName(value: string | undefined | null): boolean {
    if (!value) return false;
    const normalized = value
        .replace(/^functions\./i, '')
        .replace(/^mcp__.+?__/i, '')
        .replace(/\s+call$/i, '')
        .replace(/[._\-\s]+/g, '')
        .trim()
        .toLowerCase();
    return normalized === 'askuserquestion'
        || normalized === 'requestuserinput'
        || normalized === '사용자에게질문';
}

/**
 * True when a tool-call-start launches detached background work (Claude Code's
 * Bash tool with `run_in_background`). Such a call returns immediately, so the
 * session reaches turn-end while the job is still running — we use this to
 * exempt the conversation from the aggressive turn-end reap. Best-effort on the
 * tool input; the daemon idle knob is the reliable backstop.
 */
export function toolCallStartLaunchesBackgroundJob(ev: { name: string; args: Record<string, unknown> }): boolean {
    const bg = ev.args?.run_in_background ?? ev.args?.runInBackground;
    return bg === true;
}

function extractLocalTranscriptImageAttachments(body: RawJSONLines): LocalImageAttachment[] {
    if (body.type !== 'user' || body.isMeta || body.isSidechain) {
        return [];
    }

    const content = (body as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) {
        return [];
    }

    // Tool results are user-role messages from Claude's protocol, but they
    // represent agent tool lifecycle, not human multimodal input.
    if (content.some((block) => isRecord(block) && block.type === 'tool_result')) {
        return [];
    }

    const attachments: LocalImageAttachment[] = [];
    for (const block of content) {
        if (!isRecord(block) || block.type !== 'image') {
            continue;
        }
        const source = block.source;
        if (!isRecord(source) || source.type !== 'base64' || typeof source.data !== 'string') {
            continue;
        }

        const data = decodeBase64(source.data);
        if (data.length === 0) {
            continue;
        }

        const mimeType = typeof source.media_type === 'string' && source.media_type.startsWith('image/')
            ? source.media_type
            : 'image/png';
        const index = attachments.length + 1;
        attachments.push({
            data,
            mimeType,
            name: `claude-image-${index}.${extensionForImageMime(mimeType)}`,
        });
    }

    return attachments;
}

function escapeMultipartValue(value: string): string {
    return value.replaceAll('\r', '').replaceAll('\n', '').replaceAll('"', '%22');
}

function buildMultipartUploadBody(
    fields: Record<string, string> | undefined,
    data: Uint8Array,
): { body: Buffer; boundary: string } {
    const boundary = `----happy-cli-${randomUUID()}`;
    const chunks: Buffer[] = [];

    for (const [key, value] of Object.entries(fields ?? {})) {
        chunks.push(Buffer.from(
            `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="${escapeMultipartValue(key)}"\r\n\r\n`
            + `${value}\r\n`,
            'utf8',
        ));
    }

    chunks.push(Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="file"; filename="blob"\r\n'
        + 'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
    ));
    chunks.push(Buffer.from(data));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

    return {
        body: Buffer.concat(chunks),
        boundary,
    };
}

/**
 * The managed relay contract, as the child must enforce it.
 *
 * `serverOrigin` is the exact origin every managed attachment URL must be on.
 * A scoped bearer is only ever sent there, and never through a redirect.
 */
export type ManagedCredentialMode = {
    serverOrigin: string;
};

/**
 * Checks a URL the server handed back before a scoped bearer is sent to it.
 *
 * Exact origin, no credentials, and the path this session owns. A redirect is
 * refused at the transport (`maxRedirects: 0`) rather than inspected, because a
 * 302 is read after the request — and the request already carried the token.
 */
export function assertManagedAttachmentUrl(
    raw: string,
    managed: ManagedCredentialMode,
    sessionId: string,
): URL {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('managed attachment URL is not absolute');
    }
    if (parsed.origin !== managed.serverOrigin) {
        throw new Error('managed attachment URL is not on the configured server origin');
    }
    if (parsed.username || parsed.password) {
        throw new Error('managed attachment URL carries credentials');
    }
    const expected = `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/`;
    if (!parsed.pathname.startsWith(expected)) {
        throw new Error('managed attachment URL is not under this session');
    }
    return parsed;
}

/**
 * Requires the configured server and the managed relay origin to be the one
 * origin, compared canonically.
 *
 * String equality on the raw values would call `https://relay.test` and
 * `https://relay.test/` different, and `HTTPS://Relay.test` the same as
 * nothing at all; `URL.origin` normalises scheme, host and port and drops
 * everything that is not part of an origin.
 */
export function assertManagedServerOrigin(managed: ManagedCredentialMode): string {
    let configured: string;
    try {
        configured = new URL(configuration.serverUrl).origin;
    } catch {
        throw new Error('managed mode requires an absolute server URL');
    }
    let expected: string;
    try {
        expected = new URL(managed.serverOrigin).origin;
    } catch {
        throw new Error('managed mode requires an absolute relay origin');
    }
    if (configured !== expected) {
        throw new Error('managed relay origin does not match the configured server origin');
    }
    return expected;
}

/** One waiter per open prompt; a session does not hold many at once. */
const MAX_PENDING_CHANNEL_BINDS = 64;

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    /**
     * Identity of *this process's* attachment to the session, minted per client instance
     * (Saycode specs/desktop-messenger-channels).
     *
     * A caller that proved a runtime's capability names it when it later hands that runtime work.
     * If the process has been replaced in between — a restart, a downgrade — the id no longer
     * matches and the work is refused instead of being run by a runtime whose capability was
     * never checked. A session id cannot do this job: it survives the process.
     */
    readonly runtimeId: string = randomUUID();
    /** Permission prompts waiting for their tool call's turn to be mapped. */
    private readonly pendingChannelPermissionBinds = new Map<string, (context: {
        turnId: string; channelRequestId: string | null; runtimeId: string;
    }) => void>();
    private metadata: Metadata | null;
    private metadataVersion: number;
    // Set synchronously the moment a summary (title) message passes through this
    // client, so callers can tell "a title was already chosen this run" without
    // waiting for the async updateMetadata socket round-trip to reflect it.
    private summarySent: boolean = false;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private pendingFileEvents: FileEventMessage[] = [];
    private pendingFileEventCallback: ((data: FileEventMessage) => void) | null = null;
    private blobKey: Uint8Array | null = null;
    /**
     * In-flight attachment download promises that belong to the *current*
     * (not-yet-drained) batch. Each promise resolves to the decoded blob (or
     * null on failure), so per-message ownership is intrinsic — there is no
     * shared push-array between batches that a late download could leak into.
     */
    private pendingDownloads: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>[] = [];
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    /** 예약된 다음 dial. non-null 이면 재연결 cadence 가 돌고 있다는 뜻이다. */
    private reconnectInterval: NodeJS.Timeout | null = null;
    /** 마지막 성공 연결 이후 연속 dial 횟수. 백오프 계산용. */
    private reconnectAttempts = 0;
    /**
     * 응답을 기다리는 `socket.connect()` 가 발사된 시각. 대기 중인 dial 이 없으면 null.
     *
     * specs/machine-socket-duplicate-registration/ — apiMachine 과 같은 결함이다.
     * 기존 cadence 는 직전 dial 의 성패와 무관하게 3초마다 connect() 를 다시 불렀고,
     * 핸드셰이크가 느린 구간에서 여러 dial 이 겹쳐 성립해 서버가 같은 세션의 소켓을
     * 여러 개 들고 있게 됐다.
     */
    private reconnectDialStartedAt: number | null = null;
    /**
     * close() 로 의도적으로 끝낸 세션인가.
     *
     * 2026-09-05 프로덕션 — 리뷰 워커가 turn 을 끝내고 정리까지 마쳤는데
     * (sendSessionDeath → flush → close → client.disconnect → happyServer.stop)
     * 프로세스가 2시간 11분 살아남았다. close() 의 socket.close() 가 'disconnect'
     * 핸들러를 깨우고, 그 핸들러가 startSmartReconnect() 를 걸어 1초 뒤 소켓이 다시
     * 붙는다. 살아있는 소켓이 이벤트 루프를 붙잡아 run-once 세션이 끝나지 못했고,
     * 그 프로세스가 worktree 를 점유해 그 저장소의 리뷰 큐가 통째로 멈췄다.
     */
    private closed = false;
    private ignoreArchiveSignal = false;
    private syncFatalHandled = false;
    // Durable session-end event log baseline, captured on first connect.
    // null = baseline unavailable (fetch failed) → reconnect rechecks disabled.
    private sessionEndSeqBaseline: number | null = null;
    private hasConnectedOnce = false;
    // While a reconnect recheck is deciding whether the session was archived
    // during the disconnect, keepalives are suppressed — they set active=true
    // server-side and would mask the very state the recheck is reading.
    private archiveRecheckPending = false;
    private skipInitialMessages = false;
    private skipExistingMessagesThroughSeq: number | null = null;
    private skippedInitialMessageSeqs = new Set<number>();
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };
    private lastSeq = 0;
    private runtimeProcessedSeqCap: number | null = null;
    private pendingOutbox: Array<{ content: string; localId: string }> = [];
    private readonly sendSync: InvalidateSync;
    /**
     * Callers waiting for a specific message to be acknowledged. Registered
     * before the message is enqueued, because a flush can start immediately
     * afterwards and a waiter added later would miss its own acknowledgement.
     */
    private readonly messageAckWaiters = new Map<string, {
        settle: (outcome: MessageAckOutcome) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly receiveSync: InvalidateSync;
    private receivePollInterval: NodeJS.Timeout | null = null;
    private currentThinking = false;
    private openToolCallIds = new Set<string>();
    private openAskUserQuestionIds = new Set<string>();
    private openAskUserQuestionTurnIds = new Map<string, string>();
    private lastDaemonRuntimeReport: {
        thinking: boolean;
        hasOpenToolCall: boolean;
        pendingUserInput: boolean;
        reportedAt: number;
    } | null = null;
    private daemonRuntimeReportSeq = 0;
    private currentMode: 'local' | 'remote' = 'remote';
    private lastUserInteractionAt: number | undefined;
    private lastTurnEndAt: number | undefined;
    private assistantTurns = 0;
    private providerTokens = 0;
    private providerUsageEventIds = new Set<string>();
    private readonly claudeTurnUsage = new ClaudeTurnUsageTracker();
    private lastClaudeTurnResultUuid: string | null = null;
    private inputObservedForNextTurn = false;
    private launchedBackgroundJob = false;
    /**
     * Set only when the caller says so.
     *
     * Never inferred from the shape of the token or the key: a mode guessed
     * from a credential is a mode that changes when the credential format
     * does, and this one decides whether redirects are followed.
     */
    private readonly managed: ManagedCredentialMode | null;

    /** The origin this client is allowed to talk to, when it is a managed one. */
    getManagedOrigin(): string | null {
        return this.managed?.serverOrigin ?? null;
    }

    constructor(token: string, session: Session, managed?: ManagedCredentialMode) {
        super()
        this.token = token;
        // Before the socket, before the handlers, before anything is sent.
        //
        // Every request below is built from `configuration.serverUrl`, which
        // is process-wide and not this client's to own. A managed client that
        // accepted a mismatch would put its scoped bearer wherever that value
        // points — including the socket, which the constructor opens — and no
        // check after the fact can recall it. Agreement is required up front
        // rather than assumed to hold in some later configuration.
        //
        // What is kept is the *canonical* origin, not the text that was
        // handed in. `HTTPS://Relay.test:443/` names the same origin as
        // `https://relay.test` and is accepted as such, so storing the raw
        // spelling would then fail every `URL.origin` comparison against it —
        // the client would admit itself and refuse the very server it was
        // configured for.
        this.managed = managed ? { serverOrigin: assertManagedServerOrigin(managed) } : null;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.sendSync = new InvalidateSync(() => this.flushOutbox(), (e) => this.onSyncFatal('send', e));
        this.receiveSync = new InvalidateSync(() => this.fetchMessages(), (e) => this.onSyncFatal('receive', e));

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

        // The managed origin, where there is one: the constructor already
        // refused to exist unless it matches the configured server, and the
        // HTTP calls below already read it, so naming it here keeps the socket
        // on the same axis instead of a second source that can drift.
        this.socket = io(this.managed?.serverOrigin ?? configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId,
                happyClient: `cli-coding-session/${configuration.currentCliVersion}`
            },
            /*
             * Two socket servers share the port: the ordinary one verifies
             * account tokens, the managed one verifies scoped runner grants.
             * A managed child carries a grant, so the ordinary path drops its
             * token through to `auth.verifyToken` and rejects it — every three
             * seconds, forever. The path is the server's wire format
             * (`managedSocketPath.ts`), so this side is the one that matches
             * it; it is written out here rather than imported because the
             * server is not a dependency of this package.
             */
            path: this.managed ? '/v1/managed-updates' : '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            // dial 성공: cadence 를 끝내고 백오프를 첫 단계로 되돌린다.
            this.stopSmartReconnect();
            this.reconnectAttempts = 0;
            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.startReceivePolling();
            this.receiveSync.invalidate();
            // The 'archived' ephemeral is transient: archived-while-disconnected
            // is invisible to the handlers below (and archive keeps the session
            // row, so the message sync never 404s either). The durable
            // session-end event log covers that gap — baseline it on first
            // connect, recheck it on every reconnect.
            if (!this.hasConnectedOnce) {
                this.hasConnectedOnce = true;
                void this.initSessionEndBaseline();
            } else {
                this.archiveRecheckPending = true;
                void this.recheckArchivedWhileDisconnected();
            }
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', createRpcRequestListener({
            handleRequest: (data) => this.rpcHandlerManager.handleRequest(data),
            logger: (message) => logger.debug(`[API] ${message}`),
        }))

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API] Socket disconnected: ${reason}`);
            // dial 이 (성공 후든 핸드셰이크 중이든) 끝났다는 신호. 다음 tick 이
            // in-flight 예산을 기다리지 않고 바로 dial 할 수 있게 지운다.
            this.reconnectDialStartedAt = null;
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopReceivePolling();
            this.startSmartReconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            // dial 이 실패로 결말난 경로.
            this.reconnectDialStartedAt = null;
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopReceivePolling();
            this.startSmartReconnect();
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
                    const messageSeq = data.body.message?.seq;
                    const isSkippedCatchupMessage =
                        typeof messageSeq === 'number' && this.skippedInitialMessageSeqs.delete(messageSeq);
                    if (
                        typeof messageSeq !== 'number'
                        || (messageSeq !== this.lastSeq + 1 && !isSkippedCatchupMessage)
                        || data.body.message.content.t !== 'encrypted'
                    ) {
                        this.receiveSync.invalidate();
                        return;
                    }
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                    logger.debug('[SOCKET] [UPDATE] Decrypted message', {
                        role: typeof (body as { role?: unknown })?.role === 'string'
                            ? (body as { role: string }).role
                            : 'unknown',
                        contentType: typeof (body as { content?: { type?: unknown } })?.content?.type === 'string'
                            ? (body as { content: { type: string } }).content.type
                            : 'unknown',
                    });
                    this.routeIncomingMessage(body, data.body.message.id);
                    this.lastSeq = Math.max(this.lastSeq, messageSeq);
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                        // Check if session was archived from web/mobile
                        const meta = this.metadata as any;
                        if (meta?.lifecycleState === 'archiveRequested' || meta?.lifecycleState === 'archived') {
                            if (this.ignoreArchiveSignal) {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}) but suppressed for reconnect`);
                                this.ignoreArchiveSignal = false;
                            } else {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}), exiting...`);
                                this.emit('archived');
                            }
                        }
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

        // Session archived from web/mobile via the /archive endpoint. That path
        // flips server-side `active` but does not stamp lifecycleState into the
        // (E2E-encrypted) metadata, so the metadata-based archive trigger above
        // never fires for it. The server now sends an activity ephemeral with
        // reason='archived' to this session's connection — exit on it so we stop
        // instead of retrying the now-404 message endpoint forever.
        this.socket.on('ephemeral', (data) => {
            try {
                if (data?.type === 'activity' && data.id === this.sessionId && data.reason === 'archived') {
                    if (this.ignoreArchiveSignal) {
                        logger.debug('[SOCKET] Session archived (ephemeral) but suppressed for reconnect');
                        this.ignoreArchiveSignal = false;
                    } else {
                        logger.debug('[SOCKET] Session archived (ephemeral), exiting...');
                        this.emit('archived');
                    }
                }
            } catch (error) {
                logger.debug('[SOCKET] [EPHEMERAL] [ERROR] Error handling ephemeral', { error });
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

    onFileEvent(callback: (data: FileEventMessage) => void) {
        this.pendingFileEventCallback = callback;
        while (this.pendingFileEvents.length > 0) {
            callback(this.pendingFileEvents.shift()!);
        }
    }

    /**
     * Derive (and cache) the blob decryption key for this session.
     * Legacy sessions use deriveKey(masterSecret, 'Happy Blobs', ['master']).
     * DataKey sessions use deriveKey(dataKey, 'Happy Blobs', ['session']).
     */
    async getBlobKey(): Promise<Uint8Array> {
        if (!this.blobKey) {
            const path = this.encryptionVariant === 'dataKey' ? ['session'] : ['master'];
            this.blobKey = await deriveKey(this.encryptionKey, 'Happy Blobs', path);
        }
        return this.blobKey;
    }

    private async requestAttachmentUpload(filename: string, size: number): Promise<AttachmentUploadResult> {
        const base = this.managed ? this.managed.serverOrigin : configuration.serverUrl;
        const response = await axios.post<AttachmentUploadResult>(
            `${base}/v1/sessions/${encodeURIComponent(this.sessionId)}/attachments/request-upload`,
            { filename, size },
            {
                headers: this.authHeaders(),
                timeout: 30000,
                // Managed: a redirect would carry the bearer somewhere this
                // client never agreed to send it.
                ...(this.managed ? { maxRedirects: 0 } : {}),
            },
        );

        const upload = response.data;
        if (
            !upload
            || typeof upload.ref !== 'string'
            || typeof upload.uploadUrl !== 'string'
            || (upload.method !== undefined && upload.method !== 'PUT' && upload.method !== 'POST')
        ) {
            throw new Error('request-upload returned an invalid response');
        }

        const method = upload.method ?? 'PUT';
        if (this.managed) {
            // The relay contract: this server, this session, a plain PUT. A
            // presigned POST would carry its own authority to another origin.
            if (method !== 'PUT') {
                throw new Error('managed upload must be a PUT to the relay');
            }
            assertManagedAttachmentUrl(upload.uploadUrl, this.managed, this.sessionId);
        }

        return { ...upload, method };
    }

    private async uploadEncryptedAttachmentBlob(upload: AttachmentUploadResult, encrypted: Uint8Array): Promise<void> {
        if (upload.method === 'POST') {
            const { body, boundary } = buildMultipartUploadBody(upload.formFields, encrypted);
            await axios.post(upload.uploadUrl, body, {
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                },
                timeout: 60000,
                maxBodyLength: 10 * 1024 * 1024,
            });
            return;
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
        };
        if (this.managed) {
            assertManagedAttachmentUrl(upload.uploadUrl, this.managed, this.sessionId);
            headers.Authorization = `Bearer ${this.token}`;
        } else if (upload.uploadUrl.startsWith(configuration.serverUrl)) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        await axios.put(upload.uploadUrl, Buffer.from(encrypted), {
            headers,
            timeout: 60000,
            maxBodyLength: 10 * 1024 * 1024,
            ...(this.managed ? { maxRedirects: 0 } : {}),
        });
    }

    async uploadLocalImageAttachmentEnvelope(
        attachment: LocalImageAttachment,
        opts: Pick<CreateEnvelopeOptions, 'id' | 'time' | 'claudeUuid' | 'codexItemId'> = {},
    ): Promise<SessionEnvelope> {
        const blobKey = await this.getBlobKey();
        const encrypted = encryptBlob(attachment.data, blobKey);
        const upload = await this.requestAttachmentUpload(attachment.name, encrypted.length);
        await this.uploadEncryptedAttachmentBlob(upload, encrypted);

        return createEnvelope('user', {
            t: 'file',
            ref: upload.ref,
            name: attachment.name,
            size: attachment.data.length,
            mimeType: attachment.mimeType,
        }, opts);
    }

    /**
     * Download an encrypted attachment blob via the request-download flow:
     * POST /request-download → { downloadUrl } → GET downloadUrl. Local mode
     * downloadUrl points back at our server (Bearer required); S3 mode is a
     * presigned URL that does not accept extra headers.
     */
    async downloadAttachment(ref: string): Promise<Uint8Array> {
        const base = this.managed ? this.managed.serverOrigin : configuration.serverUrl;
        const requestUrl = `${base}/v1/sessions/${this.sessionId}/attachments/request-download`;
        const requestRes = await axios.post(
            requestUrl,
            { ref },
            {
                headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                timeout: 30000,
                // Both metadata calls, not only the blob transfers: a redirect
                // on this one carries the bearer just as far.
                ...(this.managed ? { maxRedirects: 0 } : {}),
            },
        );
        const downloadUrl = requestRes.data?.downloadUrl;
        if (typeof downloadUrl !== 'string') {
            throw new Error('request-download returned no downloadUrl');
        }

        const headers: Record<string, string> = {};
        if (this.managed) {
            assertManagedAttachmentUrl(downloadUrl, this.managed, this.sessionId);
            headers['Authorization'] = `Bearer ${this.token}`;
        } else if (downloadUrl.startsWith(configuration.serverUrl)) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        const response = await axios.get(downloadUrl, {
            headers,
            responseType: 'arraybuffer',
            timeout: 60000,
            // BYOS follows a presigned redirect; managed never does.
            maxRedirects: this.managed ? 0 : 5,
            maxContentLength: 10 * 1024 * 1024,
        });
        return new Uint8Array(response.data);
    }

    /**
     * Download and decrypt an attachment blob.
     * Returns the decrypted binary data or null if decryption fails.
     */
    async downloadAndDecryptAttachment(ref: string): Promise<Uint8Array | null> {
        const encrypted = await this.downloadAttachment(ref);
        const key = await this.getBlobKey();
        const decrypted = decryptBlob(encrypted, key);
        return decrypted;
    }

    /**
     * Track an attachment download whose promise resolves to the decoded blob
     * (or null on failure). The download stays in the current batch until the
     * next drainAttachmentsForUserMessage call swaps the bucket out — file
     * events that arrive after the swap go into a fresh bucket bound to the
     * next user-text message.
     */
    trackAttachmentDownload(promise: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>): void {
        this.pendingDownloads.push(promise);
    }

    /**
     * Atomically claim every download started before this call, wait for them
     * to resolve, and return the successful ones. The swap-then-await order
     * guarantees that a late-arriving file event cannot leak into this batch.
     */
    async drainAttachmentsForUserMessage(): Promise<Array<{ data: Uint8Array; mimeType: string; name: string }>> {
        const downloads = this.pendingDownloads;
        this.pendingDownloads = [];
        if (downloads.length === 0) return [];
        const results = await Promise.all(downloads);
        return results.filter((x): x is { data: Uint8Array; mimeType: string; name: string } => x !== null);
    }

    private authHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
        };
    }

    private routeIncomingMessage(message: unknown, serverMessageId?: string) {
        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            const userMessage: UserMessage = serverMessageId
                ? { ...userResult.data, serverMessageId }
                : userResult.data;
            this.inputObservedForNextTurn = true;
            if (userMessage.meta?.sentFrom !== 'daemon') {
                this.lastUserInteractionAt = Date.now();
            }
            this.reportDaemonRuntime(this.currentThinking, true);
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userMessage);
            } else {
                this.pendingMessages.push(userMessage);
            }
            return;
        }

        // Check for file events (image attachments from app)
        const fileResult = FileEventMessageSchema.safeParse(message);
        if (fileResult.success) {
            const ev = fileResult.data.content.data.ev;
            logger.debug('[API] Received file event', {
                size: ev.size,
                hasMimeType: Boolean(ev.mimeType),
            });
            if (this.pendingFileEventCallback) {
                this.pendingFileEventCallback(fileResult.data);
            } else {
                this.pendingFileEvents.push(fileResult.data);
            }
            return;
        }

        this.emit('message', message);
    }

    private async fetchMessages() {
        // On reconnect, skip only messages that existed before the agent reattached.
        const skipRouting = this.skipInitialMessages;
        const skipThroughSeq = this.skipExistingMessagesThroughSeq;
        if (skipRouting) {
            this.skipInitialMessages = false;
            this.skipExistingMessagesThroughSeq = null;
            logger.debug('[API] Reconnect mode: skipping existing messages through baseline seq', {
                sessionId: this.sessionId,
                skipThroughSeq,
            });
        }

        let afterSeq = this.lastSeq;
        while (true) {
            const response = await axios.get<V3GetSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    params: {
                        after_seq: afterSeq,
                        limit: 100
                    },
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            let maxSeq = afterSeq;

            for (const message of messages) {
                if (message.seq > maxSeq) {
                    maxSeq = message.seq;
                }

                // A polling request can begin before a live socket update advances
                // lastSeq, then return the same durable message afterward. Re-check
                // the shared cursor at apply time so the message is routed once.
                if (message.seq <= this.lastSeq) {
                    continue;
                }

                const shouldSkipExistingMessage = skipRouting
                    && (skipThroughSeq === null || message.seq <= skipThroughSeq);
                if (shouldSkipExistingMessage) {
                    if (message.content?.t === 'encrypted') {
                        this.skippedInitialMessageSeqs.add(message.seq);
                    }
                    continue;
                }

                if (message.content?.t !== 'encrypted') {
                    continue;
                }

                try {
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
                    this.routeIncomingMessage(body, message.id);
                } catch (error) {
                    logger.debug('[API] Failed to decrypt fetched message', {
                        sessionId: this.sessionId,
                        seq: message.seq,
                        error
                    });
                }
            }

            this.lastSeq = Math.max(this.lastSeq, maxSeq);
            const hasMore = !!response.data.hasMore;
            if (hasMore && maxSeq === afterSeq) {
                logger.debug('[API] fetchMessages pagination stalled, stopping to avoid infinite loop', {
                    sessionId: this.sessionId,
                    afterSeq
                });
                break;
            }
            afterSeq = maxSeq;
            if (!hasMore) {
                break;
            }
        }
    }

    private static readonly MAX_OUTBOX_BATCH_SIZE = 50;
    private static readonly RECEIVE_POLL_INTERVAL_MS = 5000;

    private startReceivePolling() {
        this.stopReceivePolling();
        this.receivePollInterval = setInterval(() => {
            if (this.socket.connected) {
                this.receiveSync.invalidate();
            }
        }, ApiSessionClient.RECEIVE_POLL_INTERVAL_MS);
        this.receivePollInterval.unref?.();
    }

    private stopReceivePolling() {
        if (!this.receivePollInterval) return;
        clearInterval(this.receivePollInterval);
        this.receivePollInterval = null;
    }

    /**
     * A message sync (send/receive) hit a permanently non-retryable error —
     * almost always a 404 after the session was deleted/archived server-side.
     * The InvalidateSync has already stopped itself; tear the whole session down
     * (same path as the archive signal) rather than leaving the process alive
     * with one dead sync direction silently dropping messages.
     */
    private onSyncFatal(which: 'send' | 'receive', error: unknown) {
        // Both syncs can fail near-simultaneously; only tear down once.
        if (this.syncFatalHandled) {
            return;
        }
        this.syncFatalHandled = true;
        // Nothing will be flushed after this, so no acknowledgement can arrive.
        this.settleAllMessageAcks('sync-failed');
        // A sync 404/410 is NOT proof the session row is gone: happy-server
        // returns the identical 404 for "row deleted" and "row exists under
        // another account" (2026-07-23 incident — the session was alive, the
        // credentials were mismatched), and the bounded retry in backoff has
        // already ruled out a transient lookup miss. Tear the session down
        // either way (this sync direction is dead), but NEVER stamp archive
        // from a 404 alone — archive is only confirmed by explicit signals
        // (archive ephemeral, durable session-end recheck). The session stays
        // resumable once the credential/server issue clears.
        const sessionUnreachable = isSessionGoneError(error);
        logger.debug(`[SOCKET] ${which} sync stopped on non-retryable error (sessionUnreachable=${sessionUnreachable}), exiting session without archive stamp:`, error);
        this.emit('archived', { stampArchive: false });
    }

    /**
     * Capture the newest durable session-end event seq at startup. Everything
     * at or below this seq predates this process (previous runs' graceful
     * deaths, an old archive before a resume) and must not trigger an exit.
     * Anything above it appeared while THIS process is alive — and since we
     * only send our own session-end during cleanup, a newer event means an
     * external archive/kill happened while our socket was down.
     * (specs/followups/session-archive-ephemeral-miss.md)
     */
    private async initSessionEndBaseline() {
        try {
            const response = await axios.get<V3GetSessionEventsResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/events`,
                {
                    params: { type: 'session-end', order: 'desc', limit: 1 },
                    headers: this.authHeaders(),
                    timeout: 30000
                }
            );
            const events = Array.isArray(response.data.events) ? response.data.events : [];
            this.sessionEndSeqBaseline = events.length > 0 ? events[0].seq : 0;
            logger.debug('[API] session-end baseline captured', { baseline: this.sessionEndSeqBaseline });
        } catch (error) {
            // Leave the baseline null — reconnect rechecks stay disabled, which
            // fails safe (behaves exactly like before this feature existed).
            logger.debug('[API] Failed to capture session-end baseline, reconnect recheck disabled:', error);
        }
    }

    /**
     * After a reconnect, decide whether the session was archived/killed while
     * our socket was down (the transient 'archived' ephemeral would have been
     * missed). A session-end event newer than our baseline says someone ended
     * the session during our lifetime; `active === false` confirms it stayed
     * dead (an active session means it was legitimately revived — e.g. control
     * transfer — and the event is stale). Keepalives are gated via
     * archiveRecheckPending so our own presence pings can't flip active=true
     * back on mid-decision.
     */
    private async recheckArchivedWhileDisconnected() {
        try {
            if (this.sessionEndSeqBaseline === null || this.syncFatalHandled) {
                return;
            }
            const eventsResponse = await axios.get<V3GetSessionEventsResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/events`,
                {
                    params: { type: 'session-end', after_seq: this.sessionEndSeqBaseline, limit: 100 },
                    headers: this.authHeaders(),
                    timeout: 30000
                }
            );
            const events = Array.isArray(eventsResponse.data.events) ? eventsResponse.data.events : [];
            if (events.length === 0) {
                return;
            }
            // Advance the baseline so a stale (revived) event can't re-trigger
            // on every later reconnect.
            this.sessionEndSeqBaseline = events.reduce((max, e) => Math.max(max, e.seq), this.sessionEndSeqBaseline);

            const lookupResponse = await axios.post<V2SessionLookupResponse>(
                `${configuration.serverUrl}/v2/sessions/lookup`,
                { ids: [this.sessionId] },
                { headers: this.authHeaders(), timeout: 30000 }
            );
            const record = Array.isArray(lookupResponse.data.sessions)
                ? lookupResponse.data.sessions.find((s) => s.id === this.sessionId)
                : undefined;
            if (record?.active === true) {
                logger.debug('[API] session-end seen during disconnect but session is active again (revived), ignoring');
                return;
            }
            if (this.ignoreArchiveSignal) {
                logger.debug('[API] Session archived while disconnected but suppressed for reconnect');
                this.ignoreArchiveSignal = false;
                return;
            }
            logger.debug('[API] Session was archived/killed while disconnected, exiting...');
            this.emit('archived');
        } catch (error) {
            // Recheck is best-effort: on any failure keep running (same
            // behavior as before this feature).
            logger.debug('[API] archived-while-disconnected recheck failed:', error);
        } finally {
            this.archiveRecheckPending = false;
        }
    }

    private async flushOutbox() {
        // Post in enqueue (oldest-first) order. The server assigns each
        // message's `seq` at insertion time, and every consumer (desktop,
        // mobile) renders messages sorted by that seq — it is the only
        // ordering signal they have. Posting newest-first (as this used to,
        // to surface "recent activity" sooner) permanently assigns the
        // *lowest* seq to the *newest* content once a backlog exceeds one
        // batch, silently corrupting render order for the rest of the
        // session's life. That backlog isn't hypothetical: FORK BACKFILL
        // (runClaude.ts) enqueues an entire historical transcript — hundreds
        // of messages — before the first flush ever runs. "Show recent
        // activity fast" is already handled correctly on the read side via
        // latest-first paginated loading (fetchLatestMessagesPage); nothing
        // needs the write path to reorder.
        while (this.pendingOutbox.length > 0) {
            const batchSize = Math.min(this.pendingOutbox.length, ApiSessionClient.MAX_OUTBOX_BATCH_SIZE);
            const batch = this.pendingOutbox.slice(0, batchSize);

            const response = await axios.post<V3PostSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    messages: batch
                },
                {
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            const maxSeq = messages.reduce((acc, message) => (
                message.seq > acc ? message.seq : acc
            ), this.lastSeq);
            this.lastSeq = maxSeq;
            this.pendingOutbox.splice(0, batch.length);
            // Resolution rides the existing flush rather than a second POST, so
            // ordering against everything already queued is unchanged. Only the
            // localIds this batch actually carried are considered: a response
            // naming anything else must not confirm a message that has not been
            // sent yet.
            this.resolveMessageAcks(messages, new Set(batch.map((item) => item.localId)));
        }
    }

    /**
     * Waits for one enqueued message to be acknowledged by the server.
     *
     * Register before enqueuing. The returned promise always resolves: an
     * unobserved acknowledgement is an outcome, not an exception, and a
     * rejected promise nobody awaited would surface as an unhandled rejection.
     */
    awaitMessageAck(localId: string, deadlineMs: number): Promise<MessageAckOutcome> {
        if (this.messageAckWaiters.has(localId)) {
            throw new Error(`message ack waiter already registered for ${localId}`);
        }
        return new Promise<MessageAckOutcome>((resolve) => {
            const settle = (outcome: MessageAckOutcome) => {
                const entry = this.messageAckWaiters.get(localId);
                if (!entry) return;
                this.messageAckWaiters.delete(localId);
                clearTimeout(entry.timer);
                resolve(outcome);
            };
            const timer = setTimeout(() => settle({ ok: false, reason: 'deadline' }), deadlineMs);
            timer.unref?.();
            this.messageAckWaiters.set(localId, { settle, timer });
            // Registering after the session already died would otherwise wait
            // for a flush that will never run.
            if (this.closed) settle({ ok: false, reason: 'closed' });
            else if (this.syncFatalHandled) settle({ ok: false, reason: 'sync-failed' });
        });
    }

    private resolveMessageAcks(
        rows: ReadonlyArray<{ id: string; seq: number; localId: string | null }>,
        sentLocalIds: ReadonlySet<string>,
    ): void {
        if (this.messageAckWaiters.size === 0) return;
        for (const localId of [...this.messageAckWaiters.keys()]) {
            if (!sentLocalIds.has(localId)) continue;
            const ack = readMessageAck(rows, localId);
            // `absent` is not a verdict: this batch simply did not carry it,
            // and a later batch or the deadline decides.
            if (ack.ok) this.messageAckWaiters.get(localId)?.settle(ack);
            else if (ack.reason === 'contradictory-ack') {
                this.messageAckWaiters.get(localId)?.settle({ ok: false, reason: 'contradictory-ack' });
            }
        }
    }

    private settleAllMessageAcks(reason: 'closed' | 'sync-failed'): void {
        for (const localId of [...this.messageAckWaiters.keys()]) {
            this.messageAckWaiters.get(localId)?.settle({ ok: false, reason });
        }
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true, localId?: string) {
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.pendingOutbox.push({
            content: encrypted,
            localId: localId ?? randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    private enqueueSessionProtocolEnvelopes(
        envelopes: SessionEnvelope[],
        invalidate: boolean = true,
        localId?: string,
    ) {
        let pendingLocalId = localId;
        for (let i = 0; i < envelopes.length; i += 1) {
            const envelope = envelopes[i];
            const envelopeLocalId = pendingLocalId && envelope.role === 'user' && envelope.ev.t === 'text'
                ? pendingLocalId
                : undefined;
            this.enqueueSessionProtocolEnvelope(envelope, invalidate && i === envelopes.length - 1, envelopeLocalId);
            if (envelopeLocalId) pendingLocalId = undefined;
        }
    }

    private applyClaudeSessionMessageSideEffects(body: RawJSONLines, observedAiAuthSource?: ObservedAiAuthSource) {
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            let sourceEventId: string | undefined;
            try {
                const rawMessage = body.message as { id?: unknown; model?: unknown };
                const rawTimestamp = (body as { timestamp?: unknown }).timestamp;
                const parsedTimestamp = typeof rawTimestamp === 'string'
                    ? Date.parse(rawTimestamp)
                    : rawTimestamp;
                const occurredAt = typeof parsedTimestamp === 'number' && Number.isFinite(parsedTimestamp)
                    ? Math.floor(parsedTimestamp)
                    : Date.now();
                const providerUsageEvent = createClaudeUsageEvent({
                    sessionId: this.sessionId,
                    occurredAt,
                    messageId: typeof rawMessage.id === 'string' ? rawMessage.id : null,
                    transcriptUuid: body.uuid,
                    model: typeof rawMessage.model === 'string' ? rawMessage.model : null,
                    usage: body.message.usage,
                    observedAiAuthSource,
                });
                sourceEventId = providerUsageEvent.sourceEventId;
                this.sendProviderUsageEvent(providerUsageEvent);
                this.claudeTurnUsage.noteAssistant({
                    usage: body.message.usage,
                    model: typeof rawMessage.model === 'string' ? rawMessage.model : null,
                });
            } catch (error) {
                logger.warn('[SOCKET] Failed to normalize provider usage data:', error);
            }

            try {
                this.sendUsageData(body.message.usage, body.message.model, sourceEventId);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.summarySent = true;
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    /**
     * Declares that the next turn to open answers an external messenger request
     * (Saycode specs/desktop-messenger-channels).
     *
     * Called by the launcher at the moment it takes a batch off the queue, which is the only
     * point where "this work" and "that request" are both known. The mapper consumes it on the
     * `turn-start` it stamps, so an id set for a turn that never opens cannot leak onto a later
     * unrelated one. Passing null clears it, which is what an in-app batch does.
     */
    setPendingTurnRequestId(requestId: string | null): void {
        this.claudeSessionProtocolState.pendingRequestId = requestId;
    }

    /**
     * Binds a permission prompt to the turn **that contains its tool call**, whenever both facts
     * are known (Saycode specs/desktop-messenger-channels — R9).
     *
     * Order-independent on purpose. The SDK reads the assistant message and the permission
     * `control_request` off one transport loop but puts them on different paths —
     * `handleControlRequest` is dispatched without being awaited, and the message is enqueued into
     * a separate input stream our own loop drains — so either can be observed first. "Which turn
     * is current" would therefore sometimes name the previous turn, and a binding against the
     * previous turn accepts an answer aimed at it while refusing the right one.
     *
     * So this waits for membership rather than reading a moving value: whichever of the two
     * arrives second triggers the bind. Nothing is bound until then, which is the fail-closed
     * direction — an answer arriving early is refused as `unknown-request`.
     */
    bindChannelPermissionWhenKnown(
        toolCallId: string,
        apply: (context: { turnId: string; channelRequestId: string | null; runtimeId: string }) => void,
    ): void {
        const membership = toolCallTurnFor(this.claudeSessionProtocolState, toolCallId);
        if (membership) {
            apply({
                turnId: membership.turnId,
                channelRequestId: membership.requestId,
                runtimeId: this.runtimeId,
            });
            return;
        }
        // Bounded: one waiter per tool call, replaced rather than stacked, and dropped when the
        // turn it would have belonged to is mapped.
        this.pendingChannelPermissionBinds.set(toolCallId, apply);
        while (this.pendingChannelPermissionBinds.size > MAX_PENDING_CHANNEL_BINDS) {
            const oldest = this.pendingChannelPermissionBinds.keys().next();
            if (oldest.done) break;
            this.pendingChannelPermissionBinds.delete(oldest.value);
        }
    }

    /** Resolves waiters whose tool call has since been mapped to a turn. */
    private drainChannelPermissionBinds(): void {
        if (this.pendingChannelPermissionBinds.size === 0) return;
        for (const [toolCallId, apply] of [...this.pendingChannelPermissionBinds]) {
            const membership = toolCallTurnFor(this.claudeSessionProtocolState, toolCallId);
            if (!membership) continue;
            this.pendingChannelPermissionBinds.delete(toolCallId);
            apply({
                turnId: membership.turnId,
                channelRequestId: membership.requestId,
                runtimeId: this.runtimeId,
            });
        }
    }

    /**
     * Publishes the engine's authoritative final answer for an open or pending channel turn
     * (Saycode specs/desktop-messenger-channels — R14).
     *
     * A result with no preceding transcript opens its pending channel turn first. An in-app turn shows its
     * answer in the transcript, and adding a duplicate envelope for it would be noise on every
     * ordinary session. Silently does nothing otherwise, which is why callers can hand it every
     * result without checking first.
     */
    sendFinalAnswerForChannelTurn(text: string): void {
        const mapped = mapClaudeChannelFinalAnswer(this.claudeSessionProtocolState, text);
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes, false);
    }

    /**
     * `observedAiAuthSource` is the remote run's own observation of its login
     * (src/claude/aiAuthObservation.ts), captured when the SDK message arrived.
     * It is an argument so that nothing else — a local-mode transcript line,
     * a later run — can pick it up.
     */
    sendClaudeSessionMessage(body: RawJSONLines, localId?: string, observedAiAuthSource?: ObservedAiAuthSource) {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes, true, localId);
        this.applyClaudeSessionMessageSideEffects(body, observedAiAuthSource);
        // A `tool-call-start` may have just named the turn a waiting prompt belongs to.
        this.drainChannelPermissionBinds();
    }

    async sendClaudeSessionMessageFromLocalTranscript(body: RawJSONLines): Promise<void> {
        const attachments = extractLocalTranscriptImageAttachments(body);
        if (attachments.length === 0) {
            this.sendClaudeSessionMessage(body);
            return;
        }

        const closeMapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, 'completed');
        this.claudeSessionProtocolState.currentTurnId = closeMapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(closeMapped.envelopes, false);

        const claudeUuid = typeof (body as { uuid?: unknown }).uuid === 'string'
            ? (body as { uuid: string }).uuid
            : undefined;
        for (const attachment of attachments) {
            try {
                const envelope = await this.uploadLocalImageAttachmentEnvelope(attachment, { claudeUuid });
                this.enqueueSessionProtocolEnvelope(envelope, false);
            } catch (error) {
                logger.debug('[API] Failed to upload local Claude transcript image attachment', {
                    sessionId: this.sessionId,
                    name: attachment.name,
                    error,
                });
            }
        }

        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes, mapped.envelopes.length > 0);
        if (mapped.envelopes.length === 0) {
            this.sendSync.invalidate();
        }
        this.applyClaudeSessionMessageSideEffects(body);
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes);
    }

    closeOpenAskUserQuestionsAsCancelled() {
        const openQuestionIds = Array.from(this.openAskUserQuestionIds);
        if (openQuestionIds.length === 0) {
            return;
        }

        const turnId = this.claudeSessionProtocolState.currentTurnId
            ?? this.openAskUserQuestionTurnIds.get(openQuestionIds[0]);
        if (!turnId) {
            return;
        }

        const envelopes: SessionEnvelope[] = openQuestionIds.map((call) => (
            createEnvelope('agent', { t: 'tool-call-end', call }, {
                turn: this.openAskUserQuestionTurnIds.get(call) ?? turnId
            })
        ));
        // Carries the correlation the mapper's own `closeTurn` would have carried. This path
        // builds the turn-end by hand, so without this a cancelled channel turn ends with no
        // `requestId` and the caller waits forever for an answer that was already decided.
        const requestId = this.claudeSessionProtocolState.currentRequestId ?? undefined;
        envelopes.push(createEnvelope(
            'agent',
            { t: 'turn-end', status: 'cancelled', ...(requestId ? { requestId } : {}) },
            { turn: turnId },
        ));

        this.claudeSessionProtocolState.currentTurnId = null;
        // Cleared for the same reason the mapper clears them: an id left behind here would be
        // stamped onto whatever turn opens next, which answers the wrong request.
        this.claudeSessionProtocolState.currentRequestId = null;
        this.claudeSessionProtocolState.pendingRequestId = null;
        this.enqueueSessionProtocolEnvelopes(envelopes);
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

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true, localId?: string) {
        this.applySessionProtocolRuntimeSideEffects(envelope);

        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content, invalidate, localId);
    }

    private applySessionProtocolRuntimeSideEffects(envelope: SessionEnvelope) {
        const openToolCallCount = this.openToolCallIds.size;
        const openAskUserQuestionCount = this.openAskUserQuestionIds.size;

        if (envelope.ev.t === 'tool-call-start') {
            if (isAskUserQuestionToolName(envelope.ev.name)) {
                this.openAskUserQuestionIds.add(envelope.ev.call);
                if (typeof envelope.turn === 'string' && envelope.turn.length > 0) {
                    this.openAskUserQuestionTurnIds.set(envelope.ev.call, envelope.turn);
                }
            } else {
                this.openToolCallIds.add(envelope.ev.call);
                // A background job (e.g. Bash run_in_background) returns its
                // tool call immediately, so the session looks idle at turn end
                // while the detached work keeps running. Flag the conversation
                // so the reaper falls back to the conservative absolute cut
                // instead of the aggressive turn-end reap. Best-effort: the
                // flag is derived from the tool input, and the daemon idle knob
                // is the reliable backstop if the field name ever changes.
                if (!this.launchedBackgroundJob && toolCallStartLaunchesBackgroundJob(envelope.ev)) {
                    this.launchedBackgroundJob = true;
                }
            }
        } else if (envelope.ev.t === 'tool-call-end') {
            this.openToolCallIds.delete(envelope.ev.call);
            this.openAskUserQuestionIds.delete(envelope.ev.call);
            this.openAskUserQuestionTurnIds.delete(envelope.ev.call);
        } else if (envelope.ev.t === 'turn-end') {
            this.openToolCallIds.clear();
            this.openAskUserQuestionIds.clear();
            this.openAskUserQuestionTurnIds.clear();
        }

        if (this.openToolCallIds.size !== openToolCallCount || this.openAskUserQuestionIds.size !== openAskUserQuestionCount) {
            this.reportDaemonRuntime(this.currentThinking, true);
        }
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope, localId?: string) {
        if (envelope.role !== 'user') {
            this.enqueueSessionProtocolEnvelope(envelope, true, localId);
            return;
        }

        if (envelope.ev.t !== 'text') {
            this.enqueueSessionProtocolEnvelope(envelope, true, localId);
            return;
        }

        this.enqueueSessionProtocolEnvelope(envelope, true, localId);
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
     * Relay one coalesced slice of streaming assistant text. Volatile on
     * purpose: a dropped frame costs nothing because the persisted assistant
     * message that follows is authoritative, and the consumer detects the gap
     * via `seq`.
     */
    sendStreamDelta(frame: StreamDeltaFrame) {
        this.socket.volatile.emit('session-stream', {
            sid: this.sessionId,
            time: Date.now(),
            data: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, frame)),
        });
    }

    /** A bounded, opt-in daemon duration record sent through the existing opaque stream relay. */
    sendTurnLatency(diagnostic: ClaudeTurnLatencyDiagnostic) {
        this.socket.volatile.emit('session-stream', {
            sid: this.sessionId,
            time: Date.now(),
            data: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, diagnostic)),
        });
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        // A reconnect recheck is reading the server-side `active` flag to
        // decide if we were archived while disconnected — a keepalive now
        // would set active=true and mask it. Skip; the next tick resumes.
        if (this.archiveRecheckPending) {
            return;
        }
        this.currentThinking = thinking;
        this.currentMode = mode;
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
        this.reportDaemonRuntime(thinking);
    }

    private reportDaemonRuntime(thinking: boolean, force = false) {
        const hasOpenToolCall = this.openToolCallIds.size > 0;
        // Blocked waiting on a human: an open AskUserQuestion, or a pending
        // permission/approval request that the Claude/Codex permission handlers
        // mirror into agentState.requests. Codex approvals never open a tool
        // call (exec_approval_request is deliberately not mapped to
        // tool-call-start), so agentState.requests is the only signal for them.
        // Reported as not-thinking for the UI, but surfaced separately so the
        // daemon idle guard never reaps a session waiting on the user.
        const hasPendingPermissionRequest = Object.keys(this.agentState?.requests ?? {}).length > 0;
        const pendingUserInput = (this.openAskUserQuestionIds.size > 0 || hasPendingPermissionRequest) && !hasOpenToolCall;
        const daemonThinking = thinking && !pendingUserInput;
        const now = Date.now();

        const prev = this.lastDaemonRuntimeReport;

        // Stamp a user-interaction timestamp on user-caused transitions: the
        // agent starting a turn (idle -> thinking) means the user just sent a
        // prompt, and an AskUserQuestion clearing (pending -> not pending) means
        // the user just answered. The daemon idle guard uses this to protect
        // sessions the user touched recently, without conflating it with
        // keep-alive liveness.
        if ((daemonThinking && !prev?.thinking && !this.inputObservedForNextTurn)
            || (prev?.pendingUserInput === true && !pendingUserInput)) {
            this.lastUserInteractionAt = now;
        }
        if (daemonThinking && !prev?.thinking) this.inputObservedForNextTurn = false;

        // Stamp a turn-end timestamp when the agent goes from busy to fully idle
        // (finished a turn, now waiting on the user). This marks a safe point to
        // reclaim a done conversation before the multi-day absolute cut.
        const prevBusy = !!prev && (prev.thinking || prev.hasOpenToolCall || prev.pendingUserInput);
        const nowIdle = !daemonThinking && !hasOpenToolCall && !pendingUserInput;
        if (prevBusy && nowIdle) {
            this.lastTurnEndAt = now;
            this.assistantTurns += 1;
        }

        if (!force && prev
            && prev.thinking === daemonThinking
            && prev.hasOpenToolCall === hasOpenToolCall
            && prev.pendingUserInput === pendingUserInput
            && now - prev.reportedAt < DAEMON_RUNTIME_REPORT_MAX_INTERVAL_MS) {
            return;
        }

        this.lastDaemonRuntimeReport = {
            thinking: daemonThinking,
            hasOpenToolCall,
            pendingUserInput,
            reportedAt: now
        };
        void notifyDaemonSessionRuntime(this.sessionId, {
            reportSeq: ++this.daemonRuntimeReportSeq,
            thinking: daemonThinking,
            hasOpenToolCall,
            pendingUserInput,
            ...(this.lastUserInteractionAt !== undefined ? { lastUserInteractionAt: this.lastUserInteractionAt } : {}),
            ...(this.lastTurnEndAt !== undefined ? { lastTurnEndAt: this.lastTurnEndAt } : {}),
            ...(this.assistantTurns > 0 ? { assistantTurns: this.assistantTurns } : {}),
            ...(this.providerTokens > 0 ? { providerTokens: this.providerTokens } : {}),
            ...(this.launchedBackgroundJob ? { launchedBackgroundJob: true } : {}),
            // Resume skip-baseline: the last seq delivered to the agent loop.
            // Without it the daemon falls back to the server-head seq, which
            // swallows messages that arrive while the session has no process.
            lastProcessedSeq: this.runtimeProcessedSeqCap ?? this.lastSeq,
            mode: this.currentMode,
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
    /**
     * 턴 종료 result 메시지. Z.AI 호환 경로처럼 assistant usage 가 0 으로 온 턴은 result 의
     * 토큰으로 한 번 보정한다 (src/usage/claudeTurnUsage.ts). 이미 계량된 턴은 건드리지 않는다.
     */
    applyClaudeTurnResult(result: {
        uuid?: unknown;
        usage?: unknown;
        modelUsage?: unknown;
    }, observedAiAuthSource?: ObservedAiAuthSource) {
        // 같은 result 가 두 번 전달돼도(SDK 재전달) 한 턴은 한 번만 본다.
        if (typeof result.uuid === 'string' && result.uuid === this.lastClaudeTurnResultUuid) return;
        if (typeof result.uuid === 'string') this.lastClaudeTurnResultUuid = result.uuid;
        const usage = result.usage && typeof result.usage === 'object' ? result.usage as Usage : null;
        const modelUsage = result.modelUsage && typeof result.modelUsage === 'object'
            ? result.modelUsage as Record<string, { inputTokens?: number; outputTokens?: number }>
            : null;
        const fallback = this.claudeTurnUsage.resolveResult({ usage, modelUsage });
        if (!fallback || typeof result.uuid !== 'string' || !result.uuid.trim()) return;
        let sourceEventId: string | undefined;
        try {
            const providerUsageEvent = createClaudeTurnUsageEvent({
                sessionId: this.sessionId,
                occurredAt: Date.now(),
                resultUuid: result.uuid,
                model: fallback.model,
                usage: fallback.usage,
                observedAiAuthSource,
            });
            sourceEventId = providerUsageEvent.sourceEventId;
            this.sendProviderUsageEvent(providerUsageEvent);
        } catch (error) {
            logger.warn('[SOCKET] Failed to normalize turn usage data:', error);
            return;
        }
        try {
            this.sendUsageData(fallback.usage, fallback.model ?? undefined, sourceEventId);
        } catch (error) {
            logger.debug('[SOCKET] Failed to send turn usage data:', error);
        }
    }

    sendUsageData(usage: Usage, model?: string, sourceEventId?: string) {
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
            },
            ...(sourceEventId ? { sourceEventId } : {}),
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    sendProviderUsageEvent(event: ProviderUsageEventV1) {
        const parsed = ProviderUsageEventV1Schema.parse(event);
        this.socket.emit('provider-usage-report', parsed);
        if (!this.providerUsageEventIds.has(parsed.sourceEventId)) {
            this.providerUsageEventIds.add(parsed.sourceEventId);
            this.providerTokens += parsed.tokens.total;
            this.reportDaemonRuntime(this.currentThinking, true);
        }
    }

    /**
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    /**
     * Whether this session already has a title. True if a summary message was
     * sent this run (tracked synchronously, so it's reliable even before the
     * async metadata round-trip lands) or if the loaded metadata already
     * carries a non-empty summary (e.g. a resumed session titled earlier).
     */
    hasTitle(): boolean {
        return this.summarySent || !!this.metadata?.summary?.text?.trim();
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    suppressNextArchiveSignal() {
        this.ignoreArchiveSignal = true;
    }

    skipExistingMessages(throughSeq?: number) {
        this.skipInitialMessages = true;
        if (typeof throughSeq === 'number' && Number.isFinite(throughSeq)) {
            this.skipExistingMessagesThroughSeq = Math.max(0, throughSeq);
            this.lastSeq = Math.max(this.lastSeq, this.skipExistingMessagesThroughSeq);
        } else {
            this.skipExistingMessagesThroughSeq = null;
        }
    }

    /**
     * Keep a one-turn automation resume from acknowledging user input that
     * arrived while its privileged turn was running. The next normal resume
     * replays everything after this baseline once the automation process and
     * its scoped credentials have exited.
     */
    capRuntimeProcessedSeq(throughSeq: number) {
        this.runtimeProcessedSeqCap = Math.max(0, throughSeq);
    }

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
                    // agentState.requests feeds pendingUserInput for the daemon
                    // idle guard — re-report promptly instead of waiting for the
                    // next keep-alive tick (dedupe suppresses no-op reports).
                    this.reportDaemonRuntime(this.currentThinking);
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
            this.sendSync.invalidateAndAwait(),
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
        // socket.close() 가 부를 disconnect 핸들러보다 먼저 세운다.
        this.closed = true;
        this.settleAllMessageAcks('closed');
        this.sendSync.stop();
        this.receiveSync.stop();
        this.stopReceivePolling();
        this.stopSmartReconnect();
        this.socket.close();
    }

    private startSmartReconnect() {
        if (this.closed) {
            logger.debug('[API] Session closed — not reconnecting');
            return;
        }
        if (this.reconnectInterval) return;
        this.scheduleReconnectDial();
    }

    /** cadence 를 끝내고 기다리던 dial 도 잊는다. */
    private stopSmartReconnect() {
        if (this.reconnectInterval) {
            clearTimeout(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        this.reconnectDialStartedAt = null;
    }

    /**
     * `connect` 나 `connect_error` 를 아직 기다리는 dial 이 있는가.
     *
     * 스스로 만료된다 — 둘 중 아무것도 못 받는 핸드셰이크가 single-flight 가드를
     * "영원히 재연결 안 함"으로 바꿔 버리면 안 된다.
     */
    private isReconnectDialInFlight(): boolean {
        if (this.reconnectDialStartedAt === null) return false;
        if (Date.now() - this.reconnectDialStartedAt < RECONNECT_DIAL_TIMEOUT_MS) return true;
        this.reconnectDialStartedAt = null;
        return false;
    }

    private scheduleReconnectDial(overrideDelayMs?: number) {
        const delayMs = overrideDelayMs ?? reconnectDelayMs(this.reconnectAttempts);
        this.reconnectInterval = setTimeout(() => {
            this.reconnectInterval = null;
            // 예약 시점이 아니라 발사 시점에 다시 읽는다 — 그 사이 close() 가
            // 들어왔을 수 있고, 그러면 이 세션은 다시 붙으면 안 된다.
            if (this.closed) return;
            if (this.socket.connected) {
                this.reconnectAttempts = 0;
                return;
            }
            if (this.isReconnectDialInFlight()) {
                // 아직 응답이 없는 dial 위에 또 쌓는 것이 소켓을 복제한 원인이다.
                this.scheduleReconnectDial();
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API] Still not ready to reconnect');
                // Not a failed dial: `reconnectAttempts` stays where it is, so
                // the backoff cannot pace this branch. Poll on its own clock
                // instead of re-asking `shouldReconnect()` every base delay for
                // as long as the machine stays shut.
                this.scheduleReconnectDial(RECONNECT_NOT_READY_POLL_MS);
                return;
            }
            this.reconnectAttempts += 1;
            this.reconnectDialStartedAt = Date.now();
            logger.debug(`[API] Attempting reconnect (attempt ${this.reconnectAttempts})`);
            this.socket.connect();
            this.scheduleReconnectDial();
        }, delayMs);
    }
}
