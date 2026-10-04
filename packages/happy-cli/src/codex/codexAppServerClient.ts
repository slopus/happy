import { takeScopeConfirmation, confirmSessionWriteScope } from '@/daemon/sessionWriteScopeConfirmation';
/**
 * Codex App Server Client — drives Codex via the v2 JSON-RPC protocol
 * (`codex app-server`), replacing the legacy MCP-based CodexMcpClient.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 *
 * WARNING: @openai/codex-sdk (v0.118.0) exists but only wraps `codex exec`
 * (non-interactive, fire-and-forget). It has NO support for `app-server`,
 * interactive approvals, or bidirectional JSON-RPC. We need app-server for
 * mobile approval routing (exec:request, patch:request, mcp:call), which is
 * why this client is hand-rolled. Re-evaluate if the SDK ever adds an
 * app-server wrapper or approval callbacks. See docs/plans/codex-app-server-migration.md.
 */

import { execSync, type ChildProcess } from 'node:child_process';
import { spawn as crossSpawn } from 'cross-spawn';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { withCodexRecallOwnership } from '@/memory/recallOwnerMarker';
import { nativeCodexRecallOwnershipOverrides } from '@/memory/nativeCodexRecallOwnership';
import { CodexBackgroundTasks, type CodexBackgroundTask } from './codexBackgroundTasks';
import { readCodexOutput } from './codexOutputReader';
import type {
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    ResumeConversationParams,
    ResumeConversationResponse,
    ForkConversationParams,
    ForkConversationResponse,
    ReadConversationParams,
    ReadConversationResponse,
    RollbackConversationParams,
    RollbackConversationResponse,
    InjectItemsParams,
    InjectItemsResponse,
    CompactConversationParams,
    CompactConversationResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    Thread,
    InterruptConversationParams,
    SteerConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
    McpServerStartupStatus,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import type { CheckpointSessionComposition, CheckpointTurnPreparation } from '@/checkpoint/checkpointSessionComposition';
import { CheckpointWriterProcessTree } from '@/checkpoint/checkpointWriterProcessTree';
import { CODEX_INACTIVITY_ABORT_REASON, type CodexInactivityAbortFields } from './codexAbortNotice';
import { prepareCodexMultiAuthProxy, type PreparedCodexMultiAuthProxy } from './codexMultiAuthProxy';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import { MandatorySandboxError, resolveSandboxInitFailureAction, type SandboxPolicyMode } from '@/sandbox/sandboxPolicy';
import { describeSandboxCapabilityFailure, verifySandboxExecutionCapability } from '@/sandbox/executionCapability';
import packageJson from '../../package.json';
import { resolveCodexSandboxPolicy } from './executionPolicy';
import { CodexAuthRecoveryError, type CodexAuthCheck, type CodexAuthSource } from './codexAuthRecovery';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    epoch: number;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

type DeferredRawTurnCompletion = {
    turnId: string | null;
    status: string | null;
    error: unknown;
    source: string;
};

type NativeCompletionObservation = {
    turnId: string | null;
    threadId: string;
    thread: { id: string; path: string } | null;
    successful: boolean | null;
    earlyCompletions: Map<string, boolean>;
    applied: boolean;
    timer?: ReturnType<typeof setTimeout>;
    onCompleted: (turnId: string, thread: { id: string; path: string } | null) => void;
    onSettled?: () => void;
};

const CODEX_AGENT_MESSAGE_DELTA_FLUSH_MS = 80;
const CODEX_AGENT_MESSAGE_DELTA_MAX_CHARS = 2_048;

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    /**
     * The provider's own turn and thread for this approval, when its request carried them
     * (Saycode specs/desktop-messenger-channels — R8/R9).
     *
     * Read off the raw request with the same extractors the turn lifecycle uses, and passed
     * through **only when present**. A consumer that needs to name the waiting turn must use this;
     * falling back to whatever turn is currently open would attribute the wait to whichever
     * request happens to be running, which is a different request's business.
     */
    turnId?: string | null;
    threadId?: string | null;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
    toolName?: string;
    input?: unknown;
    serverName?: string;
    message?: string;
}) => Promise<ReviewDecision>;

/**
 * Check that `codex app-server` is available.
 */
function parseCodexCliVersion(version: string): { major: number; minor: number; patch: number } | null {
    const match = version.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
        return null;
    }
    return { major, minor, patch };
}

function readCodexCliVersion(): { major: number; minor: number; patch: number } | null {
    try {
        const version = execSync('codex --version', { encoding: 'utf8', windowsHide: true }).trim();
        return parseCodexCliVersion(version);
    } catch {
        return null;
    }
}

function isAppServerAvailable(): boolean {
    const version = readCodexCliVersion();
    if (!version) {
        return false;
    }
    const { major, minor } = version;
    // app-server available in recent versions
    return major > 0 || minor >= 100;
}

function isGoalActionsAvailable(): boolean {
    const version = readCodexCliVersion();
    if (!version) {
        return false;
    }
    const { major, minor } = version;
    // thread/goal/set and thread/goal/clear are present in Codex 0.140+.
    return major > 0 || minor >= 140;
}

function normalizeRawFileChangeList(changes: unknown): LegacyPatchChanges | undefined {
    if (!Array.isArray(changes)) {
        return undefined;
    }

    const normalized: LegacyPatchChanges = {};
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const path = typeof change.path === 'string' ? change.path : null;
        if (!path) {
            continue;
        }

        const entry: Record<string, unknown> = {};
        const changeRecord = change as Record<string, unknown>;
        const kind = changeRecord.kind && typeof changeRecord.kind === 'object' && !Array.isArray(changeRecord.kind)
            ? changeRecord.kind as Record<string, unknown>
            : null;
        const type = typeof changeRecord.type === 'string'
            ? changeRecord.type
            : (typeof kind?.type === 'string' ? kind.type : null);
        const movePath = changeRecord.move_path ?? kind?.move_path ?? null;

        if (kind) {
            entry.kind = kind;
        } else if (type) {
            entry.kind = { type, move_path: movePath };
        }

        const diff = typeof changeRecord.diff === 'string'
            ? changeRecord.diff
            : (typeof changeRecord.unified_diff === 'string' ? changeRecord.unified_diff : null);
        if (diff !== null) {
            entry.diff = diff;
        }

        if (changeRecord.add && typeof changeRecord.add === 'object' && !Array.isArray(changeRecord.add)) {
            entry.add = changeRecord.add;
        }
        if (changeRecord.modify && typeof changeRecord.modify === 'object' && !Array.isArray(changeRecord.modify)) {
            entry.modify = changeRecord.modify;
        }
        if (changeRecord.delete && typeof changeRecord.delete === 'object' && !Array.isArray(changeRecord.delete)) {
            entry.delete = changeRecord.delete;
        }

        const content = typeof changeRecord.content === 'string' ? changeRecord.content : null;
        if (type === 'add' && content !== null) {
            entry.add = { content };
        }
        if (type === 'delete' && content !== null) {
            entry.delete = { content };
        }

        const oldContent = typeof changeRecord.oldContent === 'string'
            ? changeRecord.oldContent
            : (typeof changeRecord.old_content === 'string' ? changeRecord.old_content : null);
        const newContent = typeof changeRecord.newContent === 'string'
            ? changeRecord.newContent
            : (typeof changeRecord.new_content === 'string' ? changeRecord.new_content : null);
        if ((oldContent !== null || newContent !== null) && type !== 'add' && type !== 'delete') {
            entry.modify = {
                old_content: oldContent ?? '',
                new_content: newContent ?? '',
            };
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function applyCheckpointTurnPreparation<
    T extends { cwd?: string; writableRoots?: string[] },
>(
    opts: T | undefined,
    preparation: CheckpointTurnPreparation | void,
): T | undefined {
    if (!preparation) return opts;
    return {
        ...(opts ?? {}),
        cwd: preparation.providerPath,
        writableRoots: [preparation.providerPath],
    } as T;
}

export class CodexAppServerClient {
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private outputGate: { wait: (signal: AbortSignal) => Promise<void>; onFailure: () => void } | null = null;
    private outputReadAbort: AbortController | null = null;
    private outputDrain: Promise<void> | null = null;
    private outputSettled = true;
    private disconnectingEpoch: number | null = null;
    private preserveDisconnectingTurn = false;
    private shutdownInputFrozen = false;
    private disconnectRevision = 0;
    private initializedEpoch = -1;
    private reconnecting = 0;
    private shutdownObservationFinished = false;
    private disconnectOperation: { key: string; promise: Promise<void> } | null = null;
    private outputFailed = false;
    private turnAdmissionAbort: AbortController | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    private sandboxConfig?: SandboxConfig;
    private readonly sandboxPolicyMode: SandboxPolicyMode;
    private readonly beforeTurn?: () => Promise<CheckpointTurnPreparation | void>;
    private readonly completeTurn?: CheckpointSessionComposition['completeTurn'];
    private readonly markTurnDispatched?: () => void;
    private onTurnDispatch?: () => void;
    private readonly protectedWriterTree: CheckpointWriterProcessTree | null;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    private multiAuthProxy: PreparedCodexMultiAuthProxy | null = null;
    private readonly managedProviderArgs: string[] | null;
    private multiAuthProxyCleanup: Promise<void> | null = null;
    public sandboxEnabled = false;
    /**
     * 샌드박스가 요청됐지만 초기화가 실패해 네이티브 정책으로 떨어진 상태.
     * connect() 시점에는 permissionMode 를 아직 모르므로(턴마다 결정된다)
     * 여기서는 사실만 기록하고, 네트워크를 실제로 잃는지는 호출자가 모드를
     * 아는 턴 시점에 isSandboxFallbackNetworkLoss 로 판정한다.
     */
    public sandboxInitFailed = false;
    public sandboxInitFailureReason: string | null = null;

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    private nativeThreadMetadata: { id: string; path: string } | null = null;
    private readonly nativeCompletionObservations = new Set<NativeCompletionObservation>();
    private threadDefaults: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        writableRoots?: string[];
        mcpServers?: Record<string, unknown>;
        developerInstructions?: string | null;
    } | null = null;

    // Turn completion tracking for the currently active sendTurnAndWait call.
    // Once known, the root provider turn ID prevents nested lifecycle events
    // from resolving the caller's completion promise.
    private pendingTurnCompletion: {
        resolve: (aborted: boolean) => void;
        turnId: string | null;
        startedTurnId: string | null;
        turnIdConfirmed: boolean;
        hasSteeredInput: boolean;
        inactivityTimeoutMs: number;
        inactivityTimer: ReturnType<typeof setTimeout> | null;
        observation?: NativeCompletionObservation;
    } | null = null;

    // Tracks in-flight interruptTurn() RPCs so sendTurnAndWait can wait for them
    // before starting a new turn (prevents stale turn/interrupt from aborting the next turn).
    private pendingInterrupt: Promise<void> | null = null;
    // Server → client requests (approvals, elicitations) awaiting our response.
    // The turn is legitimately idle while these are outstanding.
    private outstandingServerRequests = 0;

    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private completedTurnIds = new Set<string>();
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();
    // Codex can report turn/completed before its commandExecution item has
    // completed. Give trailing item completion a chance to arrive; on an
    // authoritative turn end, reconcile remaining commands as background work
    // instead of holding the conversation open for a long-lived server.
    private openCommandExecutionTurns = new Map<string, string | null>();
    private openCommandLabels = new Map<string, string>();
    private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
    private backgroundTasks = new CodexBackgroundTasks(
        (method, params) => this.request(method, params, 3000),
        (tasks) => this.eventHandler?.({ type: 'background_tasks', tasks }),
    );

    restoreBackgroundTasks(tasks: CodexBackgroundTask[]): void {
        this.backgroundTasks.restore(tasks);
    }

    private scheduleBackgroundRefresh(delay = 5000): void {
        if (delay === 1000 && this.backgroundTimer) {
            clearTimeout(this.backgroundTimer);
            this.backgroundTimer = null;
        }
        if (this.backgroundTimer || !this._threadId || !this.connected) return;
        this.backgroundTimer = setTimeout(() => {
            this.backgroundTimer = null;
            const threadId = this._threadId;
            const epoch = this.processEpoch;
            if (!threadId) return;
            // Only an authoritative terminal transfers open commands out of
            // the foreground. Neither text nor an idle/final-answer fallback does.
            const terminal = this.deferredRawTurnCompletion?.source === 'turn/completed'
                ? this.deferredRawTurnCompletion : null;
            const candidates = terminal ? [...this.openCommandExecutionTurns]
                .filter(([, turn]) => !terminal.turnId || !turn || turn === terminal.turnId)
                .map(([callId]) => ({ callId, command: this.openCommandLabels.get(callId) ?? '' })) : [];
            void this.backgroundTasks.refresh(threadId, candidates).then(() => {
                if (!this.connected || this._threadId !== threadId || this.processEpoch !== epoch) return;
                if (terminal && this.deferredRawTurnCompletion === terminal) {
                    for (const { callId } of candidates) {
                        this.openCommandExecutionTurns.delete(callId);
                        this.openCommandLabels.delete(callId);
                    }
                    this.flushDeferredRawTurnCompletion();
                }
                if (this.backgroundTasks.hasTasks || this.deferredRawTurnCompletion?.source === 'turn/completed') {
                    this.scheduleBackgroundRefresh();
                }
            });
        }, delay);
        this.backgroundTimer.unref?.();
    }
    private deferredRawTurnCompletion: DeferredRawTurnCompletion | null = null;
    private rawTurnCompletionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingAgentMessageDeltas = new Map<string, string>();
    private sentAgentMessageChars = new Map<string, number>();
    private pendingAgentMessageDeltaChars = 0;
    private agentMessageDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

    // Last known startup status per MCP server.
    // Used to explain a watchdog-forced abort: a turn can hang building its tool
    // list while waiting on a server that never became ready.
    private mcpServerStatuses = new Map<string, McpServerStartupStatus>();
    // Snapshot taken the moment *our* inactivity watchdog fires, so the turn's
    // terminal event can be distinguished from a user-initiated cancel. Captured
    // at fire time (not at emission) because MCP servers may become ready during
    // the interrupt grace period, which would erase the culprit from the report.
    private pendingInactivityAbort: CodexInactivityAbortFields | null = null;

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;
    private cancelPendingApprovals: (() => void | Promise<void>) | null = null;
    private approvalCancellation: Promise<void> | null = null;
    private approvalShutdownFailed = false;
    private readonly serverRequestTasks = new Set<Promise<void>>();

    // specs/linux-checkpoint-enforcement-backend R4 — the turn workspace materialized by beforeTurn()
    // must exist before the wrapped process starts: bubblewrap binds a mount point on the host for
    // every non-existent deny path the moment bwrap runs, which would leave the freshly reserved
    // workspace non-empty. prepareProtectedTurn() runs the gate first and sendTurnAndWait() consumes
    // the result instead of running the gate a second time.
    private preparedTurn: CheckpointTurnPreparation | null = null;
    private static readonly PROCESS_EXIT_WAIT_MS = 5_000;

    constructor(
        sandboxConfig?: SandboxConfig,
        beforeTurn?: () => Promise<CheckpointTurnPreparation | void>,
        completeTurn?: CheckpointSessionComposition['completeTurn'],
        /** 생략하면 개인 머신(owner-choice)으로 본다 — sandbox/sandboxPolicy.ts */
        sandboxPolicyMode: SandboxPolicyMode = 'owner-choice',
        /**
         * The provider configuration a managed Cloud run must use.
         *
         * Present only for a managed run, and then it is the whole story: the
         * account-rotation proxy is not consulted, and the provider is not
         * chosen from whatever is in the user's config file.
         */
        managedProviderArgs?: string[] | null,
        markTurnDispatched?: () => void,
        /** Host-only decision retained across reconnects; never a user/provider override. */
        private readonly recallHostPrepared = false,
    ) {
        this.sandboxConfig = sandboxConfig;
        this.sandboxPolicyMode = sandboxPolicyMode;
        this.beforeTurn = beforeTurn;
        this.completeTurn = completeTurn;
        this.managedProviderArgs = managedProviderArgs ?? null;
        this.markTurnDispatched = markTurnDispatched;
        this.protectedWriterTree = completeTurn ? new CheckpointWriterProcessTree() : null;
    }

    get threadId(): string | null {
        return this._threadId;
    }

    get turnId(): string | null {
        return this._turnId;
    }

    get isConnected(): boolean {
        return this.connected;
    }

    supportsGoalActions(): boolean {
        return isGoalActionsAvailable();
    }

    getMcpStartupStatuses(): McpServerStartupStatus[] {
        return [...this.mcpServerStatuses.values()]
            .map((status) => ({ ...status }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    setOutputStorageGate(gate: { wait: (signal: AbortSignal) => Promise<void>; onFailure: () => void }): void {
        if (this.process) throw new Error('Set output storage gate before spawning Codex');
        this.outputGate = gate;
    }
    async waitForOutputDrain(): Promise<void> {
        await this.outputDrain;
        // EOF only settles parsing; approval callbacks may still publish final state.
        await this.approvalCancellation;
        if (this.approvalShutdownFailed) throw new Error('Codex approval cancellation failed');
        await Promise.all([...this.serverRequestTasks]);
    }

    /** Permanent for this client/launch. The runtime must separately freeze its other producers. */
    freezeInputForShutdown(): boolean {
        if (this.shutdownInputFrozen || !this.outputGate || !this.process || this.disconnectOperation || this.outputFailed || this.completeTurn
            || this.initializedEpoch !== this.processEpoch || this.reconnecting > 0) return false;
        this.shutdownInputFrozen = true;
        this.shutdownObservationFinished = false;
        this.turnAdmissionAbort?.abort();
        const failed = () => { this.approvalShutdownFailed = true; this.failOutputStorage(); };
        try {
            this.approvalCancellation = Promise.resolve(this.cancelPendingApprovals?.())
                .catch(failed).finally(() => { this.approvalCancellation = null; });
        } catch { failed(); }
        return true;
    }

    /** Coordinator releases observation ownership; input stays permanently frozen. */
    finishShutdownObservation(): void { this.shutdownObservationFinished = true; }

    private hasPendingOutputProducers(): boolean {
        return !this.outputSettled || this.serverRequestTasks.size > 0 || this.approvalCancellation !== null;
    }

    cancelOutputDrain(): void {
        if (this.hasPendingOutputProducers()) this.failOutputStorage();
        this.outputReadAbort?.abort();
    }

    private assertInputOpen(): void {
        if (this.shutdownInputFrozen) throw new Error('Codex input is frozen for shutdown');
    }

    private failOutputStorage(): void {
        if (this.outputFailed) return;
        this.outputFailed = true;
        try { this.outputGate?.onFailure(); }
        catch { logger.warn('[CodexAppServer] Output failure observer failed'); }
    }

    private async admitTurn(): Promise<void> {
        this.assertInputOpen();
        if (!this.outputGate) return;
        if (this.turnAdmissionAbort) throw new Error('A turn is already waiting for storage');
        const controller = new AbortController();
        this.turnAdmissionAbort = controller;
        let cancel!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            cancel = () => reject(new Error('Codex turn admission aborted'));
            controller.signal.addEventListener('abort', cancel, { once: true });
        });
        try {
            await Promise.race([this.outputGate.wait(controller.signal), cancelled]);
            if (controller.signal.aborted) throw new Error('Codex turn admission aborted');
            if (!this.connected || this.outputFailed || this.disconnectingEpoch === this.processEpoch) throw new Error('Codex output is unavailable');
        } finally {
            controller.signal.removeEventListener('abort', cancel);
            if (this.turnAdmissionAbort === controller) this.turnAdmissionAbort = null;
        }
    }


    /** Runtime claim commits at the request write, not the earlier checkpoint preparation hooks. */
    setTurnDispatchHandler(handler: () => void): void { this.onTurnDispatch = handler; }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    /** Replaces the handler/cancellation pair; omitting cancellation clears the old hook. */
    setApprovalHandler(handler: ApprovalHandler, cancelPending?: () => void | Promise<void>): void {
        this.approvalHandler = handler;
        this.cancelPendingApprovals = cancelPending ?? null;
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    /** Same shape as `extractTurnId`, for the thread. Absent stays absent — nothing is inferred. */
    private extractThreadId(params: any): string | null {
        const threadId = params?.thread?.id ?? params?.threadId ?? params?.thread_id ?? null;
        return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = method === 'thread/started'
            || method === 'thread/goal/updated'
            || method === 'thread/goal/cleared'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/status/changed'
            || method === 'thread/tokenUsage/updated'
            || method === 'rawResponse/completed'
            || method.startsWith('item/');

        if (!isRawNotification) {
            return false;
        }

        if (this.notificationProtocol === 'legacy') {
            return false;
        }

        if (this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        return true;
    }

    /** MCP servers whose last reported startup status is anything other than 'ready'. */
    private getNotReadyMcpServers(): string[] {
        const notReady: string[] = [];
        for (const [name, status] of this.mcpServerStatuses) {
            if (status.status !== 'ready') notReady.push(name);
        }
        return notReady;
    }

    /**
     * If the current turn was force-interrupted by our inactivity watchdog,
     * returns the diagnostic snapshot to attach to the turn's terminal event and
     * clears it. Returns null for user-initiated aborts (which stay silent).
     */
    private consumeInactivityAbortFields(): CodexInactivityAbortFields | null {
        const fields = this.pendingInactivityAbort;
        this.pendingInactivityAbort = null;
        return fields;
    }

    /**
     * completedTurnIds exists to dedupe the SAME completion reported twice in
     * quick succession (codex/event and v2 turn/completed racing for one
     * turn, or a stray fallback timer firing after the authoritative signal
     * already did — see emitOrDeferRawTurnCompletion/scheduleRawTurnCompletionFallback).
     * It must not survive genuine NEW work starting: a mid-turn agentMessage
     * can legitimately carry phase 'final_answer' (e.g. a clarifying
     * question), which fires our idle-fallback task_complete while Codex has
     * not actually finished. Codex then resumes the SAME provider turn — no
     * fresh turn/started precedes it, since it never asked for a new turn —
     * and with pendingTurnCompletion already null at that point, this
     * resumed activity is the only signal available that the earlier
     * completion was premature. Reopen the consumer lifecycle and forget the
     * stale marker so the eventual authoritative completion is delivered as a
     * balanced start/end pair instead of silently dropped. Otherwise the
     * session receives no durable terminal marker for the resumed work
     * (desktop-stuck-responding-state: a live client stayed "응답중" 24+
     * minutes past the real end of work because of exactly this).
     * Scoped to item/started (a new work item beginning) and its legacy
     * exec_command_begin equivalent — never to item/completed or its legacy
     * counterparts, so the same-tick dual-protocol completion race above
     * stays untouched.
     */
    private reopenConsumerLifecycleOnResumedWork(turnId: string | null): void {
        if (this.pendingTurnCompletion) return;
        if (this.completedTurnIds.size === 0) return;
        logger.debug('[CodexAppServer] New work started with no pending turn; reopening consumer lifecycle', {
            turnIds: [...this.completedTurnIds],
        });
        this.completedTurnIds.clear();
        if (turnId) {
            this._turnId = turnId;
        }
        this.eventHandler?.({
            type: 'task_started',
            ...(turnId ? { turn_id: turnId } : {}),
        });
    }

    private emitRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        const aborted = status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';

        if (!this.tryResolvePendingTurn(aborted, turnId, source)) {
            return;
        }
        this._turnId = null;
        this.clearAgentMessageDeltas();

        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }
        if (turnId) {
            this.completedTurnIds.add(turnId);
        }

        // Attach on BOTH branches: codex may settle a watchdog interrupt with
        // status 'completed' (seen in production), which must still be reported.
        const inactivity = this.consumeInactivityAbortFields();

        this.eventHandler?.({
            type: aborted ? 'turn_aborted' : 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(error !== undefined && error !== null ? { error } : {}),
            ...(inactivity ?? {}),
        });
    }

    private hasOpenCommandsForTurn(turnId: string | null): boolean {
        for (const commandTurnId of this.openCommandExecutionTurns.values()) {
            if (!turnId || !commandTurnId || commandTurnId === turnId) {
                return true;
            }
        }
        return false;
    }

    private emitOrDeferRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        if (!this.matchesPendingTurn(turnId)) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; terminal event is deferred for another turn`,
            );
            return;
        }
        this.clearRawTurnCompletionFallback();
        if (this.deferredRawTurnCompletion) {
            // final_answer and idle are fallback completion signals. Preserve
            // the authoritative turn/completed status when it arrives while a
            // command is still draining.
            if (source === 'turn/completed') {
                this.deferredRawTurnCompletion = { turnId, status, error, source };
                this.scheduleBackgroundRefresh(1000);
            }
            return;
        }
        if (this.hasOpenCommandsForTurn(turnId)) {
            this.deferredRawTurnCompletion = { turnId, status, error, source };
            if (source === 'turn/completed') this.scheduleBackgroundRefresh(1000);
            return;
        }
        this.emitRawTurnCompletion(turnId, status, error, source);
    }

    private clearRawTurnCompletionFallback(): void {
        if (!this.rawTurnCompletionFallbackTimer) return;
        clearTimeout(this.rawTurnCompletionFallbackTimer);
        this.rawTurnCompletionFallbackTimer = null;
    }

    private scheduleRawTurnCompletionFallback(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        if (!this.matchesPendingTurn(turnId)) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; terminal event is deferred for another turn`,
            );
            return;
        }
        this.clearRawTurnCompletionFallback();
        this.rawTurnCompletionFallbackTimer = setTimeout(() => {
            this.rawTurnCompletionFallbackTimer = null;
            this.emitOrDeferRawTurnCompletion(turnId, status, error, source);
        }, CodexAppServerClient.RAW_TURN_COMPLETION_FALLBACK_GRACE_MS);
    }

    private flushDeferredRawTurnCompletion(): void {
        const deferred = this.deferredRawTurnCompletion;
        if (!deferred || this.hasOpenCommandsForTurn(deferred.turnId)) {
            return;
        }
        this.deferredRawTurnCompletion = null;
        this.emitRawTurnCompletion(deferred.turnId, deferred.status, deferred.error, deferred.source);
    }

    private flushAgentMessageDeltas(finalItemId?: string): void {
        if (this.agentMessageDeltaFlushTimer) {
            clearTimeout(this.agentMessageDeltaFlushTimer);
            this.agentMessageDeltaFlushTimer = null;
        }

        const pending = Array.from(this.pendingAgentMessageDeltas.entries());
        this.pendingAgentMessageDeltas.clear();
        this.pendingAgentMessageDeltaChars = 0;

        for (const [itemId, text] of pending) {
            const offset = this.sentAgentMessageChars.get(itemId) ?? 0;
            const isFinal = itemId === finalItemId;
            for (let start = 0; start < text.length; start += CODEX_AGENT_MESSAGE_DELTA_MAX_CHARS) {
                const delta = text.slice(start, start + CODEX_AGENT_MESSAGE_DELTA_MAX_CHARS);
                this.eventHandler?.({
                    type: 'agent_message_delta',
                    item_id: itemId,
                    index: 0,
                    offset: offset + start,
                    delta,
                    final: isFinal && start + delta.length === text.length,
                });
            }
            if (isFinal) {
                this.sentAgentMessageChars.delete(itemId);
            } else {
                this.sentAgentMessageChars.set(itemId, offset + text.length);
            }
        }

        if (finalItemId
            && !pending.some(([itemId]) => itemId === finalItemId)
            && this.sentAgentMessageChars.has(finalItemId)) {
            const offset = this.sentAgentMessageChars.get(finalItemId) ?? 0;
            this.sentAgentMessageChars.delete(finalItemId);
            this.eventHandler?.({
                type: 'agent_message_delta',
                item_id: finalItemId,
                index: 0,
                offset,
                delta: '',
                final: true,
            });
        }
    }

    private enqueueAgentMessageDelta(itemId: string, delta: string): void {
        this.pendingAgentMessageDeltas.set(itemId, (this.pendingAgentMessageDeltas.get(itemId) ?? '') + delta);
        this.pendingAgentMessageDeltaChars += delta.length;
        if (this.pendingAgentMessageDeltaChars >= CODEX_AGENT_MESSAGE_DELTA_MAX_CHARS) {
            this.flushAgentMessageDeltas();
            return;
        }
        if (this.agentMessageDeltaFlushTimer) return;
        this.agentMessageDeltaFlushTimer = setTimeout(() => {
            this.agentMessageDeltaFlushTimer = null;
            this.flushAgentMessageDeltas();
        }, CODEX_AGENT_MESSAGE_DELTA_FLUSH_MS);
    }

    private clearAgentMessageDeltas(): void {
        if (this.agentMessageDeltaFlushTimer) {
            clearTimeout(this.agentMessageDeltaFlushTimer);
            this.agentMessageDeltaFlushTimer = null;
        }
        this.pendingAgentMessageDeltas.clear();
        this.sentAgentMessageChars.clear();
        this.pendingAgentMessageDeltaChars = 0;
    }

    private handleRawNotification(method: string, params: any): boolean {
        if (!this.shouldHandleRawNotification(method)) {
            return false;
        }

        if (method === 'turn/started') {
            const turnId = this.extractTurnId(params);
            if (this.markPendingTurnStarted(turnId)) {
                if (turnId) {
                    this._turnId = turnId;
                }
                this.eventHandler?.({
                    type: 'task_started',
                    ...(turnId ? { turn_id: turnId } : {}),
                });
            }
            return true;
        }

        if (method === 'turn/completed') {
            this.emitOrDeferRawTurnCompletion(
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
                method,
            );
            return true;
        }

        if (method === 'thread/status/changed') {
            const statusType = params?.status?.type;
            // A previous turn's idle status can arrive after the next turn/start
            // request. Only use this ID-less fallback after the response confirms
            // the turn ID and that same turn announces its start.
            const pending = this.pendingTurnCompletion;
            if (statusType === 'idle'
                && pending?.turnId
                && pending.turnIdConfirmed
                && pending.startedTurnId === pending.turnId) {
                this.emitOrDeferRawTurnCompletion(pending.turnId, 'completed', null, method);
            }
            return true;
        }

        if (method === 'thread/goal/updated') {
            const threadId = typeof params?.threadId === 'string'
                ? params.threadId
                : (typeof params?.goal?.threadId === 'string' ? params.goal.threadId : undefined);
            const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
            this.eventHandler?.({
                type: 'thread_goal_updated',
                ...(threadId ? { thread_id: threadId, threadId } : {}),
                ...(turnId ? { turn_id: turnId, turnId } : {}),
                goal: params?.goal,
            });
            return true;
        }

        if (method === 'thread/goal/cleared') {
            const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
            this.eventHandler?.({
                type: 'thread_goal_cleared',
                ...(threadId ? { thread_id: threadId, threadId } : {}),
            });
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.eventHandler?.({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        if (method === 'rawResponse/completed') {
            const responseId = typeof params?.responseId === 'string' ? params.responseId : '';
            const usage = params?.usage;
            if (!responseId || !usage || typeof usage !== 'object') {
                logger.warn('[CodexAppServer] Ignoring malformed rawResponse/completed usage notification');
                return true;
            }
            const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
            const turnId = typeof params?.turnId === 'string' ? params.turnId : undefined;
            this.eventHandler?.({
                type: 'codex_usage',
                ...(threadId ? { thread_id: threadId } : {}),
                ...(turnId ? { turn_id: turnId } : {}),
                response_id: responseId,
                usage,
            });
            return true;
        }

        if (method === 'item/agentMessage/delta') {
            const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
            const delta = typeof params?.delta === 'string' ? params.delta : '';
            if (itemId && delta) {
                this.enqueueAgentMessageDelta(itemId, delta);
            }
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            return method.startsWith('item/');
        }

        if (method === 'item/started') {
            this.reopenConsumerLifecycleOnResumedWork(this.extractTurnId(params));
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            if (callId) {
                this.openCommandExecutionTurns.set(callId, this.extractTurnId(params));
                this.openCommandLabels.set(callId, item.command ?? '');
            }
            this.eventHandler?.({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
            });
            return true;
        }

        if (method === 'item/completed' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_end',
                call_id: callId,
                callId,
                output: item.aggregatedOutput ?? '',
                exit_code: item.exitCode ?? null,
                duration_ms: item.durationMs ?? null,
                status: item.status,
                cwd: item.cwd,
                command: item.command,
            });
            if (callId) {
                this.openCommandExecutionTurns.delete(callId);
                this.openCommandLabels.delete(callId);
                this.backgroundTasks.complete(callId);
            }
            this.flushDeferredRawTurnCompletion();
            return true;
        }

        if (item.type === 'fileChange') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const changes = normalizeRawFileChangeList(item.changes);

            if (callId && changes) {
                this.rawFileChangesByItemId.set(callId, changes);
            }

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'patch_apply_begin',
                    call_id: callId,
                    callId,
                    changes: changes ?? {},
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'patch_apply_end',
                    call_id: callId,
                    callId,
                    status: item.status,
                });

                if (callId && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
                    this.rawFileChangesByItemId.delete(callId);
                }
                return true;
            }
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            if (itemId) {
                this.flushAgentMessageDeltas(itemId);
            }
            const text = typeof item.text === 'string' ? item.text : '';
            if (text.length > 0) {
                this.eventHandler?.({
                    type: 'agent_message',
                    message: text,
                    item_id: itemId,
                    phase: item.phase,
                });
            }

            if (item.phase === 'final_answer'
                && this.pendingTurnCompletion
                && !this.pendingTurnCompletion.hasSteeredInput) {
                this.scheduleRawTurnCompletionFallback(
                    this.extractTurnId(params),
                    'completed',
                    null,
                    `${method}:final_answer`,
                );
            }
            return true;
        }

        return method.startsWith('item/');
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        const scopeConfirmation = takeScopeConfirmation();
        const revision = this.disconnectRevision;
        this.assertInputOpen();
        if ((this.outputFailed && this.process) || (!this.connected && !this.outputSettled)) throw new Error('Codex output must drain before reconnect');
        if (this.connected) return;

        if (this.multiAuthProxy || this.multiAuthProxyCleanup) {
            await this.cleanupMultiAuthProxy();
        }

        if (!isAppServerAvailable()) {
            throw new Error(
                'Codex CLI is not installed\n\n' +
                'Please install Codex CLI using one of these methods:\n\n' +
                'Option 1 - npm (recommended):\n  npm install -g @openai/codex\n\n' +
                'Option 2 - Homebrew (macOS):\n  brew install --cask codex\n\n' +
                'Alternatively, use Claude Code:\n  happy claude',
            );
        }

        // Build env — same filtering as the old MCP client
        let env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') env[key] = value;
        }
        if (!this.managedProviderArgs) {
            // Account rotation swaps in another account's proxy, its own
            // client key and its own base URL. For a managed run that is a
            // different payer and a provider outside the approval, so the
            // rotation is not consulted at all rather than consulted and
            // overridden — a consulted rotation has already started a proxy
            // and picked an account.
            this.multiAuthProxy = await prepareCodexMultiAuthProxy(env);
            if (this.multiAuthProxy) {
                env = this.multiAuthProxy.env;
            }
        }

        // Older/missing hosts must never inherit another launch's ownership marker.
        env = withCodexRecallOwnership(env, this.recallHostPrepared && !this.managedProviderArgs && this.sandboxPolicyMode === 'owner-choice');

        let command = 'codex';
        let args = [
            'app-server',
            '--listen',
            'stdio://',
            ...(this.managedProviderArgs ?? this.multiAuthProxy?.args ?? []),
        ];
        this.sandboxEnabled = false;
        this.sandboxInitFailed = false;
        this.sandboxInitFailureReason = null;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(
                    this.sandboxConfig,
                    process.cwd(),
                    scopeConfirmation ? 'mandatory' : this.sandboxPolicyMode,
                );
                if (scopeConfirmation || resolveSandboxInitFailureAction(this.sandboxPolicyMode) === 'abort') {
                    const capability = await verifySandboxExecutionCapability();
                    if (!capability.ok) {
                        throw new MandatorySandboxError(
                            'capability-unavailable',
                            describeSandboxCapabilityFailure(capability),
                        );
                    }
                }
                const wrapped = await wrapForMcpTransport('codex', args);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                this.sandboxCleanup = null;
                this.sandboxInitFailed = true;
                this.sandboxInitFailureReason = error instanceof Error ? error.message : String(error);
                // 공유 머신에서는 턴을 기다리지 않는다 — 폴백한 네이티브 정책이
                // workspace-write/danger-full-access 면 호스트 전체가 열린다.
                if (scopeConfirmation || resolveSandboxInitFailureAction(this.sandboxPolicyMode) === 'abort') {
                    throw error instanceof MandatorySandboxError
                        ? error
                        : new MandatorySandboxError('init-failed', this.sandboxInitFailureReason);
                }
                if (this.beforeTurn) {
                    throw new Error(
                        'checkpoint protection sandbox initialization failed; refusing to start Codex. '
                        + `Original error: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
        }

        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        // The native seatbelt marker disables Codex's model proxy path on Linux.
        // Linux remains protected by the external bubblewrap wrapper.
        if (this.sandboxEnabled && process.platform === 'darwin') {
            env.CODEX_SANDBOX = 'seatbelt';
        } else if (this.sandboxEnabled && process.platform === 'linux' && env.CODEX_SANDBOX === 'seatbelt') {
            delete env.CODEX_SANDBOX;
        }

        logger.debug(`[CodexAppServer] Spawning: ${command} ${args.join(' ')}`);

        const epoch = ++this.processEpoch;
        // Approvals issued by a previous process can never be answered against this
        // one, and their responses are dropped by the epoch guard rather than
        // decrementing the count. Clear it here so the invariant holds for every
        // epoch bump, including a crash that skipped disconnectInternal.
        this.outstandingServerRequests = 0;
        // Use cross-spawn so npm-installed wrappers (codex.cmd / codex.ps1) resolve on Windows.
        // Native child_process.spawn fails with ENOENT for .cmd shims (issues #980, #1016).
        let proc: ReturnType<typeof crossSpawn>;
        try {
            this.assertInputOpen();
            if (revision !== this.disconnectRevision) throw new Error('Codex connection cancelled by disconnect');
            proc = crossSpawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
                windowsHide: true,
                detached: Boolean(this.protectedWriterTree),
            });
        } catch (error) {
            await this.disconnectInternal();
            throw error;
        }
        this.process = proc;
        this.protectedWriterTree?.track(proc);

        proc.on('error', (err) => {
            logger.debug('[CodexAppServer] Process error:', err);
        });

        let epochOutputDrain: Promise<void> | null = null;
        const finishExit = (code: number | null, signal: NodeJS.Signals | null) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            // Ignore stale process exits from prior generations during reconnect.
            if (this.process !== proc || this.processEpoch !== epoch) {
                logger.debug('[CodexAppServer] Ignoring stale process exit');
                return;
            }
            if (this.disconnectingEpoch === epoch) return;
            this.connected = false;
            if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
            this.backgroundTimer = null;
            this.backgroundTasks.invalidate();
            this.clearAgentMessageDeltas();
            void this.cleanupMultiAuthProxy();
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
                this.pending.delete(id);
            }
            // Resolve pending turn completion (treat as abort)
            this.resolvePendingTurn(true);
        };

        proc.on('exit', (code, signal) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            this.connected = false;
            // A root exit can precede consumption of the final stdout bytes.
            if (epochOutputDrain) {
                const abort = this.outputReadAbort;
                const timer = setTimeout(() => abort?.abort(), 5000);
                timer.unref?.();
                const done = () => { clearTimeout(timer); finishExit(code, signal); };
                void epochOutputDrain.then(done, done);
            }
            else finishExit(code, signal);
        });

        // Pipe stderr for debug logging
        proc.stderr?.on('data', (chunk: Buffer) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            const text = chunk.toString().trim();
            if (text) logger.debug(`[CodexAppServer:stderr] ${text}`);
        });

        // Parse newline-delimited JSON from stdout
        if (this.outputGate) {
            const gate = this.outputGate;
            this.outputReadAbort = new AbortController();
            this.outputSettled = false;
            this.outputFailed = false;
            this.outputDrain = readCodexOutput(proc.stdout!, {
                signal: this.outputReadAbort.signal, beforeLine: gate.wait,
                onLine: line => { if (this.process === proc && this.processEpoch === epoch) this.handleLine(line, epoch); },
            }).then(() => this.flushAgentMessageDeltas());
            epochOutputDrain = this.outputDrain;
            void this.outputDrain.then(() => { this.outputSettled = true; }, () => {
                this.outputSettled = true;
                this.failOutputStorage();
                if (this.process !== proc || this.processEpoch !== epoch || this.disconnectingEpoch === epoch) return;
                this.connected = false;
                for (const [id, request] of this.pending) {
                    if (request.epoch !== epoch) continue;
                    request.reject(new Error('Codex output could not be drained')); this.pending.delete(id);
                }
                this.resolvePendingTurn(true);
                logger.warn('[CodexAppServer] Output storage stream failed; completion is unconfirmed');
            });
        } else {
            this.readline = createInterface({ input: proc.stdout! });
            this.readline.on('line', (line) => {
                if (this.process !== proc || this.processEpoch !== epoch) return;
                this.handleLine(line, epoch);
            });
        }

        // Perform initialize handshake
        const initParams: InitializeParams = {
            clientInfo: {
                name: 'happy-codex',
                title: 'Happy Codex Client',
                version: packageJson.version,
            },
            capabilities: {
                experimentalApi: true,
            },
        };
        try {
            await this.request('initialize', initParams);
            if (revision !== this.disconnectRevision) throw new Error('Codex connection cancelled by disconnect');
            this.notify('initialized');
            this.initializedEpoch = epoch;
            this.connected = true;
            await confirmSessionWriteScope(scopeConfirmation, this.sandboxEnabled, this.sandboxConfig ?? undefined);
            logger.debug('[CodexAppServer] Connected and initialized');
        } catch (error) {
            await this.disconnectInternal();
            throw error;
        }
    }

    /**
     * Ends the app server's input and waits for it to leave on its own.
     *
     * `disconnectInternal` is a shutdown, not a flush: it does `stdin.end()`
     * and then `SIGTERM` in the same `try`, with `SIGKILL` two seconds later,
     * and never awaits the exit. A checkpoint that archives provider state
     * cannot use it — a signalled process did not flush, and an unawaited one
     * was not observed leaving at all.
     *
     * This sends **no signal**. It closes stdin and reports what the kernel
     * then said, within a budget. A timeout is reported as a timeout: the
     * caller decides whether to fall back to `disconnect()`, and that fallback
     * is a kill, so it is never quiescence.
     */
    async endInputAndAwaitExit(budgetMs: number, signal?: AbortSignal): Promise<{
        exited: boolean;
        code: number | null;
        signal: string | null;
    }> {
        if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 30000) throw new Error('Invalid exit observation budget');
        if (signal?.aborted) return { exited: false, code: null, signal: null };
        const proc = this.process;
        // Nothing to end. Reported as not-exited rather than as a clean exit:
        // "there was no process" is not "the process finished writing".
        if (!proc) return { exited: false, code: null, signal: null };
        /*
         * Already gone. `process` is not cleared by the exit handler (the
         * reconnect path needs it to tell a stale exit from a live one), so a
         * provider that left before the stop arrived would otherwise be waited
         * for again — for the whole budget — and then reported as never seen
         * leaving. What the kernel said is already on the object.
         */
        if (typeof proc.exitCode === 'number' || typeof proc.signalCode === 'string') {
            return { exited: true, code: proc.exitCode ?? null, signal: proc.signalCode ?? null };
        }

        return new Promise((resolve) => {
            let settled = false;
            const finish = (outcome: { exited: boolean; code: number | null; signal: string | null }) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                proc.removeListener('exit', onExit);
                signal?.removeEventListener('abort', onAbort);
                resolve(outcome);
            };
            const onAbort = () => finish({ exited: false, code: null, signal: null });
            const onExit = (code: number | null, signal: string | null) => finish({ exited: true, code, signal });
            const deadline = setTimeout(() => finish({ exited: false, code: null, signal: null }), budgetMs);
            deadline.unref?.();
            proc.once('exit', onExit);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) { onAbort(); return; }
            try {
                // Register before EOF: even synchronous exit must settle and release the deadline.
                proc.stdin?.end();
            } catch {
                finish({ exited: false, code: null, signal: null });
            }
        });
    }

    private disconnectInternal(opts?: Parameters<CodexAppServerClient['performDisconnectInternal']>[0]): Promise<void> {
        const key = JSON.stringify([!!opts?.preserveThreadState, !!opts?.preservePendingTurnCompletion, !!opts?.awaitProcessExit]);
        if (this.disconnectOperation) {
            return this.disconnectOperation.key === key ? this.disconnectOperation.promise
                : this.disconnectOperation.promise.then(() => this.disconnectInternal(opts), () => this.disconnectInternal(opts));
        }
        if (this.shutdownInputFrozen && (opts !== undefined || !this.shutdownObservationFinished
            || (this.process && this.process.exitCode == null && this.process.signalCode == null))) {
            return Promise.reject(new Error('Codex input is frozen for shutdown'));
        }
        if (this.shutdownInputFrozen && !this.outputSettled) {
            if (!this.outputDrain) return Promise.reject(new Error('Codex output is unavailable'));
            return this.outputDrain.then(() => this.disconnectInternal(opts), () => this.disconnectInternal(opts));
        }
        const promise = this.performDisconnectInternal(opts);
        this.disconnectOperation = { key, promise };
        const clear = () => { if (this.disconnectOperation?.promise === promise) this.disconnectOperation = null; };
        void promise.then(clear, clear);
        return promise;
    }

    private async performDisconnectInternal(opts?: {
        preserveThreadState?: boolean;
        preservePendingTurnCompletion?: boolean;
        /**
         * Wait for the provider process to exit before running the sandbox cleanup. On Linux the
         * cleanup removes the bwrap mount points from the writable workspace, and those cannot be
         * unlinked while bwrap still holds them. specs/linux-checkpoint-enforcement-backend R4/R7.
         */
        awaitProcessExit?: boolean;
    }): Promise<void> {
        if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
        this.backgroundTimer = null;
        this.backgroundTasks.invalidate();
        this.clearAgentMessageDeltas();
        if (!this.connected
            && !this.process
            && !this.sandboxCleanup
            && !this.multiAuthProxy
            && !this.multiAuthProxyCleanup) return;

        const proc = this.process;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'}`);

        this.disconnectingEpoch = epoch;
        this.preserveDisconnectingTurn = opts?.preservePendingTurnCompletion === true;
        try {
            this.turnAdmissionAbort?.abort();
            if (this.outputGate && !this.outputSettled) {
                // An orderly EOF can preserve the storage verdict on idle auth/restart paths.
                // This is a local grace period, not a runtime/Job shutdown receipt.
                try { proc?.stdin?.end(); } catch { /* settle through the fallback below */ }
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        this.outputDrain?.catch(() => {}),
                        new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); timer.unref?.(); }),
                    ]);
                } finally { if (timer) clearTimeout(timer); }
            }
            if (this.outputGate && this.hasPendingOutputProducers()) this.failOutputStorage();
            this.outputReadAbort?.abort();
            await this.outputDrain?.catch(() => {});
            this.clearAgentMessageDeltas();
            this.readline?.close();
            this.readline = null;

            const alive = proc && proc.exitCode == null && proc.signalCode == null;
            try {
                proc?.stdin?.end();
                if (alive) proc?.kill('SIGTERM');
            } catch { /* ignore */ }

            // Force kill after 2s (unref so timer doesn't block process exit)
            if (pid && alive) {
                const killTimer = setTimeout(() => {
                    if (proc.exitCode != null || proc.signalCode != null) return;
                    try {
                        process.kill(pid, 0); // check alive
                        process.kill(pid, 'SIGKILL');
                    } catch { /* already dead */ }
                }, 2000);
                killTimer.unref();
                proc?.once('exit', () => clearTimeout(killTimer));
            }

            if (opts?.awaitProcessExit && proc && proc.exitCode == null && proc.signalCode == null) {
                // The SIGKILL timer above fires at 2s; anything still alive after the cap is unkillable
                // (uninterruptible I/O), and its bwrap mount points cannot be released. Fail closed
                // rather than run the sandbox cleanup — and the next gate — on a stale process.
                let exitTimer: ReturnType<typeof setTimeout> | undefined;
                let onExit: (() => void) | undefined;
                try {
                    await new Promise<void>((resolve, reject) => {
                        onExit = () => resolve();
                        proc.once('exit', onExit);
                        exitTimer = setTimeout(
                            () => reject(new Error('Codex process did not exit before the sandbox cleanup')),
                            CodexAppServerClient.PROCESS_EXIT_WAIT_MS,
                        );
                        exitTimer.unref();
                    });
                } finally {
                    if (exitTimer) clearTimeout(exitTimer);
                    if (onExit) proc.off('exit', onExit);
                }
            }

            this.process = null;
            this.connected = false;
            this._turnId = null;
            this.notificationProtocol = 'unknown';
            this.completedTurnIds.clear();
            // Statuses describe the dead process's MCP servers; the next process
            // re-reports. Keeping them would blame stale servers in later aborts.
            this.mcpServerStatuses.clear();
            this.pendingInactivityAbort = null;
            // Approvals belonging to the dead process can never be answered; drop them
            // so a later turn's watchdog is not left permanently disarmed.
            this.outstandingServerRequests = 0;
            if (!opts?.preserveThreadState) {
                for (const observation of this.nativeCompletionObservations) this.settleNativeCompletionObservation(observation, false);
                this._threadId = null;
                this.nativeThreadMetadata = null;
                this.threadDefaults = null;
            }

            // Fail in-flight requests from this process generation.
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
                this.pending.delete(id);
            }

            // A forced restart keeps the current caller pending until the replacement
            // process has initialized and resumed the thread. This prevents the queue
            // loop from dispatching its next turn against an unresumed app-server.
            if (!opts?.preservePendingTurnCompletion) {
                this.resolvePendingTurn(true);
            }

            if (this.sandboxCleanup) {
                try { await this.sandboxCleanup(); } catch { /* ignore */ }
                this.sandboxCleanup = null;
            }
            this.sandboxEnabled = false;

            if (this.multiAuthProxy || this.multiAuthProxyCleanup) {
                await this.cleanupMultiAuthProxy();
            }

            logger.debug('[CodexAppServer] Disconnected');
        } finally {
            if (this.disconnectingEpoch === epoch) {
                this.disconnectingEpoch = null;
                this.preserveDisconnectingTurn = false;
            }
        }
    }

    async disconnect(): Promise<void> {
        this.disconnectRevision++;
        await this.disconnectInternal();
        // A queued public stop also settles state preserved by an already-finished restart.
        this.resolvePendingTurn(true);
        for (const observation of this.nativeCompletionObservations) this.settleNativeCompletionObservation(observation, false);
        this._threadId = null;
        this.nativeThreadMetadata = null;
        this.threadDefaults = null;
    }

    /**
     * Opens the next protected turn before the provider process exists. Stops a running codex first
     * so its sandbox cleanup removes any bwrap mount points from the reserved workspace, then runs
     * the checkpoint gate. Returns null when the session is not protected.
     * specs/linux-checkpoint-enforcement-backend R4
     */
    /** Drops a cached preparation that will not be dispatched; the composition owns the cleanup. */
    abortPreparedTurn(): void {
        this.preparedTurn = null;
    }

    async prepareProtectedTurn(): Promise<CheckpointTurnPreparation | null> {
        if (!this.beforeTurn) return null;
        if (this.preparedTurn) return this.preparedTurn;
        if (this.connected || this.process) {
            await this.disconnectInternal({
                preserveThreadState: true,
                preservePendingTurnCompletion: true,
                awaitProcessExit: true,
            });
        }
        const preparation = await this.beforeTurn();
        this.preparedTurn = preparation ?? null;
        return this.preparedTurn;
    }

    private cleanupMultiAuthProxy(): Promise<void> {
        if (this.multiAuthProxyCleanup) return this.multiAuthProxyCleanup;
        const proxy = this.multiAuthProxy;
        this.multiAuthProxy = null;
        if (!proxy) return Promise.resolve();

        const cleanup = Promise.resolve()
            .then(() => proxy.cleanup())
            .catch(() => undefined)
            .finally(() => {
                if (this.multiAuthProxyCleanup === cleanup) {
                    this.multiAuthProxyCleanup = null;
                }
            });
        this.multiAuthProxyCleanup = cleanup;
        return cleanup;
    }

    private async buildThreadConfig(
        mcpServers?: Record<string, unknown>,
        writableRoots?: readonly string[],
        cwd = process.cwd(),
    ): Promise<Record<string, unknown> | null> {
        const config: Record<string, unknown> = {};
        if (mcpServers) config.mcp_servers = mcpServers;
        if (this.recallHostPrepared && !this.managedProviderArgs && this.sandboxPolicyMode === 'owner-choice') {
            let nativeServers: unknown;
            try {
                // MCP stdio children filter their environment. Mark the existing native
                // CML entry explicitly rather than relying on app-server inheritance.
                // Never log this response: native config can contain credentials.
                const effective = await this.request('config/read', { cwd, includeLayers: false }, 3000) as {
                    config?: { mcp_servers?: unknown };
                };
                nativeServers = effective.config?.mcp_servers;
            } catch {
                logger.warn('[CodexAppServer] Native memory MCP ownership configuration unavailable; direct memory reads may fail.');
            }
            Object.assign(config, nativeCodexRecallOwnershipOverrides(nativeServers, mcpServers));
        }
        if (writableRoots?.length) {
            config.sandbox_workspace_write = { writable_roots: [...writableRoots] };
        }
        return Object.keys(config).length > 0 ? config : null;
    }

    private rememberThreadDefaults(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        writableRoots?: string[];
        mcpServers?: Record<string, unknown>;
        developerInstructions?: string | null;
    }): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            writableRoots: opts.writableRoots,
            mcpServers: opts.mcpServers,
            developerInstructions: opts.developerInstructions,
        };
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        writableRoots?: string[];
        mcpServers?: Record<string, unknown>;
        developerInstructions?: string | null;
    }): Promise<{ threadId: string; model: string }> {
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: await this.buildThreadConfig(opts.mcpServers, opts.writableRoots, opts.cwd ?? process.cwd()),
            baseInstructions: null,
            developerInstructions: opts.developerInstructions ?? null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        this._threadId = result.thread.id;
        this.rememberNativeThreadMetadata(result.thread);
        this.scheduleBackgroundRefresh();
        this._turnId = null;
        this.rememberThreadDefaults(opts);
        logger.debug('[CodexAppServer] Thread started:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        writableRoots?: string[];
        mcpServers?: Record<string, unknown>;
        developerInstructions?: string | null;
    }): Promise<{ threadId: string; model: string }> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const defaults = this.threadDefaults ?? {};
        const developerInstructions = opts && Object.hasOwn(opts, 'developerInstructions')
            ? opts.developerInstructions ?? null
            : defaults.developerInstructions ?? null;
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: await this.buildThreadConfig(
                opts?.mcpServers ?? defaults.mcpServers,
                opts?.writableRoots ?? defaults.writableRoots,
                opts?.cwd ?? defaults.cwd ?? process.cwd(),
            ),
            baseInstructions: null,
            developerInstructions,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/resume', params) as ResumeConversationResponse;
        this._threadId = result.thread.id;
        this.rememberNativeThreadMetadata(result.thread);
        this.scheduleBackgroundRefresh();
        this._turnId = null;
        this.rememberThreadDefaults({
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            writableRoots: opts?.writableRoots ?? defaults.writableRoots,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
            developerInstructions,
        });
        logger.debug('[CodexAppServer] Thread resumed:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async forkThread(opts: {
        threadId: string;
        path?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        writableRoots?: string[];
        mcpServers?: Record<string, unknown>;
        developerInstructions?: string | null;
    }): Promise<{ threadId: string; model: string; thread: Thread }> {
        const defaults = this.threadDefaults ?? {};
        const developerInstructions = Object.hasOwn(opts, 'developerInstructions')
            ? opts.developerInstructions ?? null
            : defaults.developerInstructions ?? null;
        const params: ForkConversationParams = {
            threadId: opts.threadId,
            ...(opts.path ? { path: opts.path } : {}),
            model: opts.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? defaults.sandbox ?? null,
            config: await this.buildThreadConfig(
                opts.mcpServers ?? defaults.mcpServers,
                opts.writableRoots ?? defaults.writableRoots,
                opts.cwd ?? defaults.cwd ?? process.cwd(),
            ),
            baseInstructions: null,
            developerInstructions,
            ephemeral: false,
            threadSource: null,
        };

        const result = await this.request('thread/fork', params) as ForkConversationResponse;
        this._threadId = result.thread.id;
        this.rememberNativeThreadMetadata(result.thread);
        this.scheduleBackgroundRefresh();
        this._turnId = null;
        this.rememberThreadDefaults({
            model: opts.model ?? defaults.model,
            cwd: opts.cwd ?? defaults.cwd,
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts.sandbox ?? defaults.sandbox,
            writableRoots: opts.writableRoots ?? defaults.writableRoots,
            mcpServers: opts.mcpServers ?? defaults.mcpServers,
            developerInstructions,
        });
        logger.debug('[CodexAppServer] Thread forked:', opts.threadId, '->', this._threadId);
        return { threadId: result.thread.id, model: result.model, thread: result.thread };
    }

    async forkThreadFromPath(opts: {
        path: string;
        cwd: string;
    }): Promise<{ threadId: string; model: string; thread: Thread }> {
        return this.forkThread({
            threadId: '',
            path: opts.path,
            cwd: opts.cwd,
        });
    }

    private rememberNativeThreadMetadata(thread: Thread): void {
        this.nativeThreadMetadata = typeof thread.path === 'string' && thread.path.length > 0
            ? { id: thread.id, path: thread.path } : null;
    }

    private settleNativeCompletionObservation(observation: NativeCompletionObservation, successful: boolean): void {
        if (!this.nativeCompletionObservations.delete(observation)) return;
        if (observation.timer) clearTimeout(observation.timer);
        try { if (successful && observation.turnId) observation.onCompleted(observation.turnId, observation.thread); }
        catch { logger.warn('[CodexAppServer] Completion observer failed'); }
        finally { try { observation.onSettled?.(); } catch { /* optional host continuation */ } }
    }

    private observeAuthoritativeNativeCompletion(turnId: string | null, threadId: string | null, successful: boolean): void {
        if (!turnId) return;
        for (const observation of this.nativeCompletionObservations) {
            if (threadId && observation.threadId !== threadId) continue;
            // Notifications can precede the turn/start RPC response, including child
            // turns. Only that accepted response identifies the owning native turn.
            if (!observation.turnId) {
                if (observation.earlyCompletions.size < 32) observation.earlyCompletions.set(turnId, successful);
                continue;
            }
            if (observation.turnId !== turnId) continue;
            observation.successful = successful;
            if (!successful || observation.applied) this.settleNativeCompletionObservation(observation, successful);
        }
    }

    async readThread(opts: {
        threadId: string;
        includeTurns?: boolean;
    }): Promise<ReadConversationResponse> {
        const params: ReadConversationParams = {
            threadId: opts.threadId,
            includeTurns: opts.includeTurns ?? true,
        };
        return await this.request('thread/read', params) as ReadConversationResponse;
    }

    async listMcpServerStatus(opts: { threadId: string; serverNames?: string[]; measureServer?: <T>(action: () => Promise<T>) => Promise<T> }): Promise<ListMcpServerStatusResponse> {
        const data: ListMcpServerStatusResponse['data'] = [];
        // A selected server reads the current thread runtime; an unscoped
        // request builds a separate status-only snapshot in Codex 0.160.0.
        const servers = opts.serverNames === undefined ? [undefined] : [...new Set(opts.serverNames)];
        for (const serverName of servers) {
            const serverData: ListMcpServerStatusResponse['data'] = [];
            let scopeIgnored = false;
            const query = async () => {
                let cursor: string | null = null;
                const seenCursors = new Set<string>();
                do {
                    const params: ListMcpServerStatusParams = {
                        threadId: opts.threadId,
                        ...(serverName === undefined ? {} : { serverName }),
                        cursor,
                        limit: 100,
                        detail: 'toolsAndAuthOnly',
                    };
                    const result = await this.request('mcpServerStatus/list', params) as ListMcpServerStatusResponse;
                    serverData.push(...result.data);
                    if (serverName !== undefined && result.data.some(entry => entry.name !== serverName)) {
                        scopeIgnored = true;
                    }
                    cursor = result.nextCursor;
                    if (cursor && seenCursors.has(cursor)) {
                        throw new Error('Codex MCP status pagination returned a repeated cursor');
                    }
                    if (cursor) seenCursors.add(cursor);
                } while (cursor);
            };
            if (opts.measureServer && serverName !== undefined) {
                let operation: Promise<void> | undefined;
                const once = () => operation ??= Promise.resolve().then(query);
                try { await opts.measureServer(once); }
                catch { /* Diagnostics never replace the inventory result. */ }
                await once();
            } else {
                await query();
            }
            // Older app-servers may ignore serverName and return the entire
            // inventory. Finish its pages, replacing any earlier scoped data.
            if (scopeIgnored) return { data: serverData, nextCursor: null };
            data.push(...serverData);
        }
        return { data, nextCursor: null };
    }

    async compactThread(opts: { threadId: string }): Promise<CompactConversationResponse> {
        const params: CompactConversationParams = { threadId: opts.threadId };
        return await this.request('thread/compact/start', params) as CompactConversationResponse;
    }

    async rollbackThread(opts: {
        threadId: string;
        numTurns: number;
    }): Promise<RollbackConversationResponse> {
        const params: RollbackConversationParams = {
            threadId: opts.threadId,
            numTurns: opts.numTurns,
        };
        return await this.request('thread/rollback', params) as RollbackConversationResponse;
    }

    async injectItems(opts: {
        threadId: string;
        items: unknown[];
    }): Promise<InjectItemsResponse> {
        const params: InjectItemsParams = {
            threadId: opts.threadId,
            items: opts.items,
        };
        return await this.request('thread/inject_items', params) as InjectItemsResponse;
    }

    async setGoal(opts: {
        threadId: string;
        objective: string;
        status?: ThreadGoalSetParams['status'];
        tokenBudget?: number | null;
    }): Promise<ThreadGoalSetResponse> {
        const params: ThreadGoalSetParams = {
            threadId: opts.threadId,
            objective: opts.objective,
            ...(opts.status !== undefined ? { status: opts.status } : {}),
            ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
        };
        return await this.request('thread/goal/set', params) as ThreadGoalSetResponse;
    }

    async clearGoal(opts: {
        threadId: string;
    }): Promise<ThreadGoalClearResponse> {
        const params: ThreadGoalClearParams = {
            threadId: opts.threadId,
        };
        return await this.request('thread/goal/clear', params) as ThreadGoalClearResponse;
    }

    get authRecoverySource(): CodexAuthSource {
        if (this.managedProviderArgs || this.sandboxPolicyMode === 'mandatory') return 'managed';
        if (this.multiAuthProxy) return 'multi-auth';
        if (process.env.CODEX_ACCESS_TOKEN || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) return 'unknown';
        return process.env.CODEX_HOME ? 'custom-home' : 'cli-login';
    }

    get authRecoveryBusy(): boolean {
        return !!this.pendingTurnCompletion || !!this.pendingInterrupt || this.outstandingServerRequests > 0 || this.pending.size > 0;
    }

    /** Explicit, idle-only recovery. Unlike legacy reconnect, failure never discards the thread. */
    private async withReconnect<T>(work: () => Promise<T>): Promise<T> {
        this.reconnecting++;
        try { return await work(); }
        finally { this.reconnecting--; }
    }

    async reconnectForAuth(): Promise<CodexAuthCheck> {
        return this.withReconnect(() => this.reconnectForAuthInternal());
    }

    private async reconnectForAuthInternal(): Promise<CodexAuthCheck> {
        const revision = this.disconnectRevision;
        const threadId = this._threadId;
        const defaults = this.threadDefaults;
        if (!threadId || this.authRecoveryBusy || this.authRecoverySource === 'managed') throw new CodexAuthRecoveryError('restart-failed');
        let phase: 'restart-failed' | 'account-check-failed' | 'resume-failed' = 'restart-failed';
        try {
            await this.disconnectInternal({ preserveThreadState: true, awaitProcessExit: true });
            if (revision !== this.disconnectRevision) throw new CodexAuthRecoveryError('restart-failed');
            await this.connect();
            phase = 'account-check-failed';
            // A rotation proxy owns authentication itself. account/read cannot verify its payer.
            let account: CodexAuthCheck = 'unverified';
            if (!this.multiAuthProxy) {
                const result = await this.request('account/read', { refreshToken: false }, 8000) as {
                    account?: { type?: string } | null; requiresOpenaiAuth?: boolean;
                };
                if (result?.requiresOpenaiAuth !== true) throw new CodexAuthRecoveryError('account-check-failed');
                if (result?.account?.type === 'chatgpt') account = 'authenticated';
                else if (result?.account?.type === 'apiKey') account = 'unverified';
                else if (result?.requiresOpenaiAuth === true && !result.account) throw new CodexAuthRecoveryError('authentication-required');
                else throw new CodexAuthRecoveryError('account-check-failed');
                if (result.account?.type === 'chatgpt') {
                    const limits = await this.request('account/rateLimits/read', undefined, 8000) as {
                        rateLimits?: { primary?: { usedPercent?: number } | null; secondary?: { usedPercent?: number } | null;
                            rateLimitReachedType?: string | null };
                    };
                    if (!limits?.rateLimits) throw new CodexAuthRecoveryError('account-check-failed');
                    const { primary, secondary, rateLimitReachedType } = limits.rateLimits;
                    if (![primary, secondary].some(window => typeof window?.usedPercent === 'number'
                        && Number.isFinite(window.usedPercent) && window.usedPercent >= 0)) {
                        throw new CodexAuthRecoveryError('account-check-failed');
                    }
                    if (rateLimitReachedType || [primary, secondary].some(window => typeof window?.usedPercent === 'number' && window.usedPercent >= 100)) {
                        throw new CodexAuthRecoveryError('limit-reached');
                    }
                }
            }
            phase = 'resume-failed';
            const resumed = await this.resumeThread({ threadId });
            if (resumed.threadId !== threadId) throw new CodexAuthRecoveryError('resume-failed');
            return account;
        } catch (error) {
            if (revision === this.disconnectRevision) {
                this._threadId = threadId;
                this.threadDefaults = defaults;
            }
            throw error instanceof CodexAuthRecoveryError ? error : new CodexAuthRecoveryError(phase);
        }
    }

    async reconnectAndResumeThread(opts?: { preservePendingTurnCompletion?: boolean }): Promise<boolean> {
        return this.withReconnect(() => this.reconnectAndResumeThreadInternal(opts));
    }

    private async reconnectAndResumeThreadInternal(opts?: { preservePendingTurnCompletion?: boolean }): Promise<boolean> {
        const revision = this.disconnectRevision;
        const threadId = this._threadId;
        await this.disconnectInternal({
            preserveThreadState: !!threadId,
            preservePendingTurnCompletion: opts?.preservePendingTurnCompletion,
        });
        if (revision !== this.disconnectRevision) throw new Error('Codex restart cancelled by disconnect');
        await this.connect();

        if (!threadId) {
            return false;
        }

        try {
            await this.resumeThread({ threadId });
            return true;
        } catch (error) {
            logger.warn('[CodexAppServer] Failed to resume thread after reconnect', error);
            this._threadId = null;
            this.threadDefaults = null;
            return false;
        }
    }

    // ─── Turn management ────────────────────────────────────────

    /** Default grace period after interrupt before forcing a restart (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;
    /** Allow the authoritative terminal notification to follow the final answer. */
    private static readonly RAW_TURN_COMPLETION_FALLBACK_GRACE_MS = 250;

    private hasPendingTurnCompletion(): boolean {
        return this.pendingTurnCompletion !== null;
    }

    private resolvePendingTurn(aborted: boolean): void {
        if (this.disconnectingEpoch === this.processEpoch && this.preserveDisconnectingTurn) return;
        if (!this.pendingTurnCompletion) return;
        if (this.pendingTurnCompletion.inactivityTimer) {
            clearTimeout(this.pendingTurnCompletion.inactivityTimer);
        }
        this.clearRawTurnCompletionFallback();
        const observation = this.pendingTurnCompletion.observation;
        if (observation) {
            if (aborted) this.settleNativeCompletionObservation(observation, false);
        }
        this.pendingTurnCompletion.resolve(aborted);
        this.pendingTurnCompletion = null;
        this.openCommandExecutionTurns.clear();
        this.openCommandLabels.clear();
        this.deferredRawTurnCompletion = null;
    }

    private schedulePendingTurnInactivityTimeout(): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;
        if (pending.inactivityTimer) {
            clearTimeout(pending.inactivityTimer);
            pending.inactivityTimer = null;
        }
        // A turn blocked on an approval prompt is waiting on *us*, not hung.
        // Leave the watchdog disarmed until every outstanding request is answered;
        // answering re-arms it with a full inactivity window.
        if (this.outstandingServerRequests > 0) return;
        pending.inactivityTimer = setTimeout(() => {
            if (this.pendingTurnCompletion !== pending) return;
            pending.inactivityTimer = null;
            this.pendingInactivityAbort = {
                reason: CODEX_INACTIVITY_ABORT_REASON,
                inactivity_timeout_ms: pending.inactivityTimeoutMs,
                not_ready_mcp_servers: this.getNotReadyMcpServers(),
            };
            logger.warn(
                `[CodexAppServer] Turn inactive for ${pending.inactivityTimeoutMs}ms — interrupting provider`,
            );
            void this.abortTurnWithFallback().catch((error) => {
                logger.warn('[CodexAppServer] Failed to abort inactive turn', error);
            });
        }, pending.inactivityTimeoutMs);
    }

    private recordPendingTurnActivity(method: string, params: any): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;
        const isTurnActivity = method === 'turn/started'
            || method === 'thread/tokenUsage/updated'
            || method === 'rawResponse/completed'
            || method === 'turn/diff/updated'
            || method.startsWith('item/')
            || method === 'codex/event'
            || method.startsWith('codex/event/');
        if (!isTurnActivity) return;

        const legacyMessage = method === 'codex/event' || method.startsWith('codex/event/')
            ? params?.msg
            : null;
        const activityTurnId = legacyMessage
            ? legacyMessage.turn_id ?? legacyMessage.turnId ?? null
            : this.extractTurnId(params);
        if (pending.turnId && activityTurnId && pending.turnId !== activityTurnId) return;

        const activityThreadId = params?.threadId ?? legacyMessage?.thread_id ?? legacyMessage?.threadId ?? null;
        if (this._threadId && activityThreadId && this._threadId !== activityThreadId) return;

        this.schedulePendingTurnInactivityTimeout();
    }

    private matchesPendingTurn(turnId?: string | null): boolean {
        const pending = this.pendingTurnCompletion;
        if (!pending) return true;
        return !pending.turnId || !turnId || pending.turnId === turnId;
    }

    private markPendingTurnStarted(turnId?: string | null): boolean {
        if (!this.matchesPendingTurn(turnId)) return false;
        if (this.pendingTurnCompletion && turnId) {
            this.pendingTurnCompletion.startedTurnId = turnId;
            if (!this.pendingTurnCompletion.turnId) {
                this.pendingTurnCompletion.turnId = turnId;
            }
        }
        return true;
    }

    private tryResolvePendingTurn(aborted: boolean, turnId: string | null, source: string): boolean {
        const pending = this.pendingTurnCompletion;
        if (!pending) return true;

        // Guard against stale completion notifications from a *different* turn.
        // We use turn ID matching instead of the `started` flag because Codex
        // can skip the turn/started notification entirely for fast turns,
        // which would cause us to discard a valid turn/completed and hang forever.
        if (!this.matchesPendingTurn(turnId)) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; awaiting ${pending.turnId}`,
            );
            return false;
        }

        this.resolvePendingTurn(aborted);
        return true;
    }

    private async waitForTurnCompletion(timeoutMs: number): Promise<boolean> {
        if (!this.hasPendingTurnCompletion()) {
            return true;
        }

        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (this.hasPendingTurnCompletion()) {
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    }

    /**
     * Request turn interruption and optionally force-restart the app-server if
     * the turn does not settle within a short grace period.
     */
    async abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
    }): Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> {
        this.turnAdmissionAbort?.abort();
        const hadActiveTurn = this.hasPendingTurnCompletion();

        // No active turn pending in this client call-site.
        if (!hadActiveTurn) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }

        // An abort is now in flight — disarm the inactivity watchdog so it can't
        // fire during the grace window and mislabel a user cancel as a timeout.
        // (For the watchdog's own call this is a no-op: its timer already fired.)
        if (this.pendingTurnCompletion?.inactivityTimer) {
            clearTimeout(this.pendingTurnCompletion.inactivityTimer);
            this.pendingTurnCompletion.inactivityTimer = null;
        }

        // Best-effort interrupt request first.
        await this.interruptTurn();

        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        const settled = await this.waitForTurnCompletion(gracePeriodMs);
        if (settled) {
            return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
        }

        if (this.shutdownInputFrozen) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }
        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
        const pendingTurnId = this.pendingTurnCompletion?.turnId ?? this._turnId;
        if (this.pendingTurnCompletion) {
            const inactivity = this.consumeInactivityAbortFields();
            this.eventHandler?.({
                type: 'turn_aborted',
                // The watchdog diagnostic wins over the generic interrupt label.
                reason: inactivity ? inactivity.reason : 'interrupted',
                ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
                forced_restart: true,
                ...(inactivity ? {
                    inactivity_timeout_ms: inactivity.inactivity_timeout_ms,
                    not_ready_mcp_servers: inactivity.not_ready_mcp_servers,
                } : {}),
            });
        }
        let resumedThread = false;
        try {
            resumedThread = await this.reconnectAndResumeThread({ preservePendingTurnCompletion: true });
        } finally {
            if (!resumedThread) {
                this._threadId = null;
                this.threadDefaults = null;
            }
            this.resolvePendingTurn(true);
        }
        return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
    }

    /**
     * Send a user turn and wait for it to complete.
     * Returns when task_complete or turn_aborted is received.
     */
    async sendTurn(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        writableRoots?: string[];
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
        beforeTurn?: () => Promise<CheckpointTurnPreparation | void>;
        /** Host observer invoked only after the provider accepts turn/start. */
        onSubmitted?: () => void;
    }): Promise<void> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        this.assertInputOpen();
        const turnPreparation = this.consumePreparedTurn(opts)
            ?? await this.resolveBeforeTurn(opts)?.();
        this.assertInputOpen();
        // From here the prompt goes to the provider: whatever happens next, the turn's workspace is
        // no longer discardable. specs/linux-checkpoint-enforcement-backend R4.
        this.markTurnDispatched?.();
        const effectiveOpts = applyCheckpointTurnPreparation(opts, turnPreparation);

        const extraInputItems = opts?.extraInputItems ?? [];
        const input: InputItem[] = [];
        if (prompt.length > 0 || extraInputItems.length === 0) {
            input.push({ type: 'text', text: prompt });
        }
        input.push(...extraInputItems);

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId: this._threadId,
            input,
        };
        if (effectiveOpts?.cwd) params.cwd = effectiveOpts.cwd;
        if (effectiveOpts?.approvalPolicy) params.approvalPolicy = effectiveOpts.approvalPolicy;
        if (effectiveOpts?.model) params.model = effectiveOpts.model;
        if (effectiveOpts?.effort) params.effort = effectiveOpts.effort;

        // Map sandbox mode to the camelCase policy format the server expects.
        if (effectiveOpts?.sandbox) {
            params.sandboxPolicy = resolveCodexSandboxPolicy(
                effectiveOpts.sandbox,
                effectiveOpts.writableRoots ?? this.threadDefaults?.writableRoots ?? [],
            );
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        const observation = this.pendingTurnCompletion?.observation;
        const result = await this.request('turn/start', params) as { turn?: { id?: string | null } };
        try { opts?.onSubmitted?.(); } catch { logger.warn('[CodexAppServer] Submission observer failed'); }
        const turnId = result?.turn?.id;
        if (typeof turnId === 'string' && turnId.length > 0) {
            if (observation && this.nativeCompletionObservations.has(observation)) {
                observation.turnId = turnId;
                observation.successful = observation.earlyCompletions.get(turnId) ?? null;
                observation.earlyCompletions.clear();
                if (observation.successful === false) this.settleNativeCompletionObservation(observation, false);
            }
            this._turnId = turnId;
            if (this.pendingTurnCompletion) {
                if (this.pendingTurnCompletion.startedTurnId !== turnId) {
                    this.pendingTurnCompletion.startedTurnId = null;
                }
                this.pendingTurnCompletion.turnId = turnId;
                this.pendingTurnCompletion.turnIdConfirmed = true;
            }
        }
    }

    /** Default maximum inactivity while waiting on turn completion (ms). */
    private static readonly TURN_TIMEOUT_MS = 10 * 60 * 1000;

    /**
     * Send a user turn and wait for it to complete (task_complete or turn_aborted).
     * Returns { aborted: true } if the turn was aborted (user cancel, permission reject, etc.).
     *
     * `turnTimeoutMs` bounds *inactivity*, not total turn duration: any turn
     * progress notification restarts the window, and it stays disarmed while an
     * approval request is awaiting the user. A turn that keeps making progress
     * therefore runs without a wall-clock limit; only a silent provider is
     * interrupted.
     */
    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        writableRoots?: string[];
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
        beforeTurn?: () => Promise<CheckpointTurnPreparation | void>;
        /** Host observer invoked only after the provider accepts turn/start. */
        onSubmitted?: () => void;
        /** Host observer of this native completion, after successful checkpoint apply. */
        onCompleted?: (turnId: string, thread: { id: string; path: string } | null) => void;
        /** Releases the pre-admitted host continuation, including unsupported/fallback completion. */
        onCompletionObservationSettled?: () => void;
        /** Max time without any turn activity before interrupting the provider. */
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        // Wait for any in-flight interruptTurn() to complete before starting a new
        // turn. Otherwise the stale turn/interrupt RPC can reach Codex after our
        // turn/start and abort the wrong turn.
        if (this.pendingInterrupt) {
            await this.pendingInterrupt;
            // Yield to the event loop so any stale turn_aborted/task_complete
            // notifications queued by the interrupted turn are processed now
            // (harmlessly, since pendingTurnCompletion is null at this point).
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        await this.admitTurn();

        // Clear any stale watchdog snapshot so it can only describe this turn's abort.
        this.pendingInactivityAbort = null;

        this.assertInputOpen();
        const turnPreparation = this.consumePreparedTurn(opts)
            ?? await this.resolveBeforeTurn(opts)?.();
        this.assertInputOpen();
        // From here the prompt goes to the provider: whatever happens next, the turn's workspace is
        // no longer discardable. specs/linux-checkpoint-enforcement-backend R4.
        this.markTurnDispatched?.();
        const effectiveOpts = applyCheckpointTurnPreparation(opts, turnPreparation);

        const timeoutMs = opts?.turnTimeoutMs ?? CodexAppServerClient.TURN_TIMEOUT_MS;
        // Checkpoint completion quiesces the provider process. Its own rollout metadata
        // must be captured now; no constructed path or model/RPC argument can replace it.
        const completedThread = this.nativeThreadMetadata?.id === this._threadId
            ? { ...this.nativeThreadMetadata } : null;
        const observation = opts?.onCompleted ? {
            turnId: null as string | null, threadId: this._threadId, thread: completedThread,
            successful: null as boolean | null, applied: false, timer: undefined as ReturnType<typeof setTimeout> | undefined,
            earlyCompletions: new Map<string, boolean>(),
            onCompleted: opts.onCompleted, onSettled: opts.onCompletionObservationSettled,
        } : undefined;
        if (observation) this.nativeCompletionObservations.add(observation);
        const completion = new Promise<boolean>((resolve) => {
            this.pendingTurnCompletion = {
                resolve,
                turnId: null,
                startedTurnId: null,
                turnIdConfirmed: false,
                hasSteeredInput: false,
                inactivityTimeoutMs: timeoutMs,
                inactivityTimer: null,
                observation,
            };
            this.schedulePendingTurnInactivityTimeout();
        });

        try {
            await this.sendTurn(
                prompt,
                effectiveOpts ? { ...effectiveOpts, beforeTurn: undefined } : undefined,
            );
        } catch (err) {
            this.resolvePendingTurn(true);
            throw err;
        }

        const aborted = await completion;
        try {
            if (this.completeTurn) {
                const applyResult = await this.completeTurn(async () => {
                    if (!this.protectedWriterTree) {
                        throw new Error('checkpoint writer process tree is unavailable');
                    }
                    await this.protectedWriterTree.quiesce(() => this.disconnectInternal({
                        preserveThreadState: true,
                        awaitProcessExit: true,
                    }));
                });
                if (applyResult.status !== 'completed') throw new Error('checkpoint turn apply did not complete');
            }
        } catch (error) {
            if (observation) this.settleNativeCompletionObservation(observation, false);
            throw error;
        }
        if (observation && this.nativeCompletionObservations.has(observation)) {
            observation.applied = true;
            if (aborted || observation.successful !== null) this.settleNativeCompletionObservation(observation, !aborted && observation.successful === true);
            else observation.timer = setTimeout(() => this.settleNativeCompletionObservation(observation, false), 2_000);
        }
        return { aborted };
    }

    private resolveBeforeTurn(
        opts: { beforeTurn?: () => Promise<CheckpointTurnPreparation | void> } | undefined,
    ) {
        return opts && Object.prototype.hasOwnProperty.call(opts, 'beforeTurn')
            ? opts.beforeTurn
            : this.beforeTurn;
    }

    /** An explicit per-call beforeTurn overrides the pre-opened turn, matching resolveBeforeTurn. */
    private consumePreparedTurn(
        opts: { beforeTurn?: () => Promise<CheckpointTurnPreparation | void> } | undefined,
    ): CheckpointTurnPreparation | null {
        if (opts && Object.prototype.hasOwnProperty.call(opts, 'beforeTurn')) return null;
        const preparation = this.preparedTurn;
        this.preparedTurn = null;
        return preparation;
    }

    async steerTurn(prompt: string): Promise<void> {
        this.assertInputOpen();
        if (!this._threadId || !this._turnId) {
            throw new Error('No active Codex turn');
        }
        if (!prompt.trim()) {
            throw new Error('Cannot steer an empty prompt');
        }

        const expectedTurnId = this._turnId;
        const params: SteerConversationParams = {
            threadId: this._threadId,
            input: [{ type: 'text', text: prompt }],
            expectedTurnId,
        };
        await this.request('turn/steer', params);

        const pending = this.pendingTurnCompletion;
        if (pending && (!pending.turnId || pending.turnId === expectedTurnId)) {
            pending.hasSteeredInput = true;
            this.clearRawTurnCompletionFallback();
        }
    }

    async interruptTurn(): Promise<void> {
        if (!this._threadId) return;
        if (!this._turnId) {
            logger.debug('[CodexAppServer] interruptTurn: no active turnId, skipping');
            return;
        }
        const params: InterruptConversationParams = {
            threadId: this._threadId,
            turnId: this._turnId,
        };
        const doInterrupt = async () => {
            try {
                await this.request('turn/interrupt', params, CodexAppServerClient.ABORT_GRACE_MS);
            } catch (err) {
                // Ignore if no turn is active
                logger.debug('[CodexAppServer] interruptTurn error (may be expected):', err);
            } finally {
                this.pendingInterrupt = null;
            }
        };
        this.pendingInterrupt = doInterrupt();
        return this.pendingInterrupt;
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this._threadId !== null;
    }

    clearThreadState(): void {
        logger.debug(
            `[CodexAppServer] Clearing thread state: thread=${this._threadId ?? 'none'} turn=${this._turnId ?? 'none'}`,
        );
        this.resolvePendingTurn(true);
        for (const observation of this.nativeCompletionObservations) this.settleNativeCompletionObservation(observation, false);
        // This resolution emits no terminal event, so drop any watchdog snapshot
        // rather than let it mislabel a later turn's abort.
        this.pendingInactivityAbort = null;
        this._threadId = null;
        this._turnId = null;
        this.nativeThreadMetadata = null;
        this.threadDefaults = null;
        this.completedTurnIds.clear();
        this.rawFileChangesByItemId.clear();
        this.mcpServerStatuses.clear();
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        if (this.shutdownInputFrozen && method !== 'turn/interrupt') return Promise.reject(new Error('Codex input is frozen for shutdown'));
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Cannot send ${method}: stdin not writable`));
                return;
            }
            // No await between this observer and stdin.write; preparation remains non-drainable until here.
            if (method === 'turn/start') this.onTurnDispatch?.();
            const id = this.nextId++;

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms (id=${id})`));
            }, timeout);

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                method,
                epoch: this.processEpoch,
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            const line = JSON.stringify(msg) + '\n';
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            this.process.stdin.write(line);
        });
    }

    private notify(method: string, params?: unknown): void {
        if (this.shutdownInputFrozen) return;
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private respond(id: number, result: unknown, sourceEpoch: number): void {
        if (this.shutdownInputFrozen) return;
        if (sourceEpoch !== this.processEpoch) {
            logger.debug(`[CodexAppServer] Ignoring response from stale epoch for id=${id}`);
            return;
        }
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private handleLine(line: string, sourceEpoch: number = this.processEpoch): void {
        if (sourceEpoch !== this.processEpoch) {
            return;
        }
        if (!line.trim()) return;

        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug('[CodexAppServer] Non-JSON line:', line.substring(0, 200));
            return;
        }

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug(`[CodexAppServer] Ignoring response from stale epoch for id=${msg.id}`);
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(`${pending.method}: ${msg.error.message} (code=${msg.error.code})`));
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null && msg.method) {
            this.outstandingServerRequests += 1;
            this.schedulePendingTurnInactivityTimeout();
            const task = this.handleServerRequest(msg.id, msg.method, msg.params, sourceEpoch).catch((err) => {
                logger.debug('[CodexAppServer] Error handling server request:', err);
            }).finally(() => {
                this.serverRequestTasks.delete(task);
                if (sourceEpoch !== this.processEpoch) return;
                this.outstandingServerRequests = Math.max(0, this.outstandingServerRequests - 1);
                this.schedulePendingTurnInactivityTimeout();
            });
            this.serverRequestTasks.add(task);
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.handleNotification(msg.method, msg.params);
            return;
        }

        logger.debugLargeJson('[CodexAppServer] Unhandled message:', msg);
    }

    /**
     * Map our internal ReviewDecision to the wire format the server expects.
     * Server uses: accept, acceptForSession, decline, cancel
     * Our handler uses: approved, approved_for_session, denied, abort
     */
    /**
     * Map our internal ReviewDecision to the wire format codex expects.
     * v2 methods (item/*) use: accept/acceptForSession/decline/cancel
     * Legacy methods (execCommandApproval/applyPatchApproval) use: approved/approved_for_session/denied/abort
     */
    private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string | Record<string, unknown> {
        if (typeof decision === 'string') {
            if (legacy) {
                // Legacy wire format — pass through as-is (approved/denied/abort)
                return decision;
            }
            // v2 wire format
            switch (decision) {
                case 'approved': return 'accept';
                case 'approved_for_session': return 'acceptForSession';
                case 'denied': return 'decline';
                case 'abort': return 'cancel';
                default: return 'decline';
            }
        }
        // Object variant: approved_execpolicy_amendment → pass through as-is
        if ('approved_execpolicy_amendment' in decision) {
            return decision;
        }
        return legacy ? 'denied' : 'decline';
    }

    private parseToolNameFromElicitationMessage(message: unknown): string | null {
        if (typeof message !== 'string') {
            return null;
        }
        const match = message.match(/tool "([^"]+)"/i);
        return match?.[1] ?? null;
    }

    private mapDecisionToMcpElicitationResponse(
        decision: ReviewDecision,
        params: any,
    ): McpServerElicitationRequestResponse {
        if (typeof decision === 'string') {
            switch (decision) {
                case 'approved':
                case 'approved_for_session':
                    return {
                        action: 'accept',
                        content: params?.mode === 'form' ? {} : null,
                        _meta: null,
                    };
                case 'abort':
                    return {
                        action: 'cancel',
                        content: null,
                        _meta: null,
                    };
                case 'denied':
                default:
                    return {
                        action: 'decline',
                        content: null,
                        _meta: null,
                    };
            }
        }

        return {
            action: 'decline',
            content: null,
            _meta: null,
        };
    }

    private async handleServerRequest(id: number, method: string, params: any, sourceEpoch: number): Promise<void> {
        // A buffered approval must not create a new runtime producer after freeze.
        if (this.shutdownInputFrozen) return;
        if (method === 'mcpServer/elicitation/request') {
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? params?.serverName ?? 'McpTool';
            const decision = await this.handleApproval({
                type: 'mcp',
                callId: `${params?.serverName ?? 'mcp'}:${id}`,
                turnId: this.extractTurnId(params),
                threadId: this.extractThreadId(params),
                toolName,
                input: params?._meta?.tool_params ?? {},
                serverName: params?.serverName,
                message: params?.message,
            });
            this.respond(id, this.mapDecisionToMcpElicitationResponse(decision, params), sourceEpoch);
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'exec',
                callId,
                turnId: this.extractTurnId(params),
                threadId: this.extractThreadId(params),
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) }, sourceEpoch);
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'patch',
                callId,
                turnId: this.extractTurnId(params),
                threadId: this.extractThreadId(params),
                fileChanges: params.fileChanges ?? (typeof callId === 'string'
                    ? this.rawFileChangesByItemId.get(callId)
                    : undefined),
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) }, sourceEpoch);
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug(`[CodexAppServer] Unknown server request: ${method}`);
        this.respond(id, {}, sourceEpoch);
    }

    private async handleApproval(params: Parameters<ApprovalHandler>[0]): Promise<ReviewDecision> {
        if (this.approvalHandler) {
            try {
                return await this.approvalHandler(params);
            } catch (err) {
                logger.debug('[CodexAppServer] Approval handler error:', err);
                return 'denied';
            }
        }
        return 'denied'; // default: deny if no handler
    }

    private handleNotification(method: string, params: any): void {
        this.recordPendingTurnActivity(method, params);

        // Memory observes only a matching authoritative success. UI final-answer/idle
        // fallbacks may settle earlier; a bounded host continuation can still receive
        // the later true completion without changing those existing UI semantics.
        if (method === 'turn/completed') {
            this.observeAuthoritativeNativeCompletion(
                this.extractTurnId(params), this.extractThreadId(params),
                this.extractTurnStatus(params) === 'completed'
                    && (params?.turn?.error ?? params?.error) == null && this.pendingInactivityAbort === null,
            );
        }

        // codex/event notifications: either `codex/event` or `codex/event/<type>`
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            if (msg) {
                const turnId = msg.turn_id ?? msg.turnId ?? null;
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    this.observeAuthoritativeNativeCompletion(
                        typeof turnId === 'string' ? turnId : null,
                        typeof (msg.thread_id ?? msg.threadId ?? params?.threadId) === 'string' ? msg.thread_id ?? msg.threadId ?? params.threadId : null,
                        msg.type === 'task_complete' && (msg.status == null || msg.status === 'completed')
                            && msg.error == null && this.pendingInactivityAbort === null,
                    );
                }
                if (msg.type === 'exec_command_begin') {
                    this.reopenConsumerLifecycleOnResumedWork(turnId);
                }
                if (msg.type === 'task_started') {
                    if (!this.markPendingTurnStarted(turnId)) return;
                    if (turnId) {
                        this._turnId = turnId;
                    }
                }
                if ((msg.type === 'task_complete' || msg.type === 'turn_aborted')
                    && !this.matchesPendingTurn(turnId)) {
                    return;
                }
                if ((msg.type === 'task_complete' || msg.type === 'turn_aborted')
                    && turnId && this.completedTurnIds.has(turnId)) {
                    return;
                }
                // Fire event handler first (so consumer processes the event).
                // Terminal events also carry the watchdog diagnostic when our
                // inactivity abort ended this turn — same contract as the raw path.
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    const inactivity = this.consumeInactivityAbortFields();
                    this.eventHandler?.(inactivity ? { ...msg, ...inactivity } : msg);
                } else {
                    this.eventHandler?.(msg);
                }
                // Then resolve turn completion promise
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    // Mark as completed so v2 turn/completed doesn't duplicate
                    if (turnId) {
                        this.completedTurnIds.add(turnId);
                    }
                    if (this.tryResolvePendingTurn(
                        msg.type === 'turn_aborted',
                        turnId,
                        `codex/event/${msg.type}`,
                    )) {
                        this._turnId = null;
                    }
                }
            }
            return;
        }

        if (this.handleRawNotification(method, params)) {
            logger.debug(`[CodexAppServer] Raw notification: ${method}`);
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${method}`);
            // Mark the turn as started so the completion guard lets it through.
            if (method === 'turn/started') {
                const turnId = this.extractTurnId(params);
                if (this.markPendingTurnStarted(turnId) && turnId) {
                    this._turnId = turnId;
                }
            }
            // turn/completed is a fallback signal — for mid-inference interrupts,
            // Codex may only signal completion here (not via codex/event turn_aborted).
            // emitRawTurnCompletion deduplicates via completedTurnIds if legacy already handled it.
            if (method === 'turn/completed') {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    this.extractTurnStatus(params),
                    params?.turn?.error ?? params?.error,
                    method,
                );
            }
            return;
        }

        // MCP server lifecycle: log payload so we can diagnose failed launches
        // (e.g. happy-mcp bridge failing on Windows due to shebang execution).
        if (method === 'mcpServer/startupStatus/updated') {
            logger.debug(`[CodexAppServer] mcpServer startup status:`, params);
            if (typeof params?.name === 'string' && typeof params?.status === 'string') {
                this.mcpServerStatuses.set(params.name, {
                    ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
                    name: params.name,
                    status: params.status,
                    ...(typeof params.error === 'string' ? { error: params.error } : {}),
                    ...(params.failureReason === 'reauthenticationRequired'
                        ? { failureReason: params.failureReason }
                        : {}),
                });
            }
            return;
        }

        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
