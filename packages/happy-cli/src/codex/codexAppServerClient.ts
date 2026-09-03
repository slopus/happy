/**
 * Codex App Server Client — drives Codex via the v2 JSON-RPC protocol
 * (`codex app-server`), replacing the legacy MCP-based CodexMcpClient.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON) or WebSocket
 * frames over the Codex app-server Unix control socket.
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 *
 * WARNING: @openai/codex-sdk (v0.118.0) exists but only wraps `codex exec`
 * (non-interactive, fire-and-forget). It has NO support for `app-server`,
 * interactive approvals, or bidirectional JSON-RPC. We need app-server for
 * mobile approval routing (exec:request, patch:request, mcp:call), which is
 * why this client is hand-rolled. Re-evaluate if the SDK ever adds an
 * app-server wrapper or approval callbacks. See docs/plans/codex-app-server-migration.md.
 */

import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawn as crossSpawn } from 'cross-spawn';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import WebSocket from 'ws';
import { logger } from '@/ui/logger';
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
    ThreadListParams,
    ThreadListResponse,
    RollbackConversationParams,
    RollbackConversationResponse,
    InjectItemsParams,
    InjectItemsResponse,
    Thread,
    ThreadGoalClearResponse,
    ThreadGoalGetResponse,
    ThreadGoalSetResponse,
    ThreadGoalStatus,
    GetAccountTokenUsageResponse,
    ListMcpServerStatusParams,
    ListMcpServerStatusResponse,
    ReviewStartParams,
    ReviewStartResponse,
    ThreadCompactStartResponse,
    InterruptConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ModelListParams,
    ModelListResponse,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
    ThreadSettings,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import packageJson from '../../package.json';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    epoch: number;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

export type CodexApprovalAuthority = 'desktop' | 'paws';

export type CodexAppServerConnection =
    | { type: 'spawn' }
    | {
        type: 'unixSocket';
        socketPath: string;
        connectTimeoutMs?: number;
        approvalAuthority?: CodexApprovalAuthority;
    };

export function resolveCodexAppServerConnection(
    env: NodeJS.ProcessEnv = process.env,
): CodexAppServerConnection {
    const mode = env.HAPPY_CODEX_APP_SERVER_MODE?.trim().toLowerCase();
    if (!mode || mode === 'spawn') {
        return { type: 'spawn' };
    }
    if (mode !== 'shared') {
        throw new Error(
            `Invalid HAPPY_CODEX_APP_SERVER_MODE=${env.HAPPY_CODEX_APP_SERVER_MODE}; expected "spawn" or "shared"`,
        );
    }

    const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    const socketPath = env.HAPPY_CODEX_APP_SERVER_SOCKET?.trim()
        || join(codexHome, 'app-server-control', 'app-server-control.sock');
    if (!isAbsolute(socketPath)) {
        throw new Error('HAPPY_CODEX_APP_SERVER_SOCKET must be an absolute path');
    }
    const approvalAuthority = env.HAPPY_CODEX_APPROVAL_AUTHORITY?.trim().toLowerCase() || 'desktop';
    if (approvalAuthority !== 'desktop' && approvalAuthority !== 'paws') {
        throw new Error(
            `Invalid HAPPY_CODEX_APPROVAL_AUTHORITY=${env.HAPPY_CODEX_APPROVAL_AUTHORITY}; expected "desktop" or "paws"`,
        );
    }
    return { type: 'unixSocket', socketPath, approvalAuthority };
}

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
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
export function resolveCodexExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
    const configuredPath = env.HAPPY_CODEX_PATH?.trim();
    if (!configuredPath) {
        return 'codex';
    }
    if (!isAbsolute(configuredPath)) {
        throw new Error('HAPPY_CODEX_PATH must be an absolute path');
    }

    const invalidPairMessage =
        'HAPPY_CODEX_PATH must point to a Codex installation with a matching code-mode host';
    try {
        if (!existsSync(configuredPath)) {
            throw new Error(invalidPairMessage);
        }
        const resolvedCodexPath = realpathSync(configuredPath);
        const hostName = process.platform === 'win32'
            ? 'codex-code-mode-host.exe'
            : 'codex-code-mode-host';
        const hostPath = join(dirname(resolvedCodexPath), hostName);
        if (
            !existsSync(hostPath)
            || dirname(realpathSync(hostPath)) !== dirname(resolvedCodexPath)
        ) {
            throw new Error(invalidPairMessage);
        }
    } catch (error) {
        if (error instanceof Error && error.message === invalidPairMessage) {
            throw error;
        }
        throw new Error(invalidPairMessage);
    }
    return configuredPath;
}

export function isAppServerAvailable(command: string): boolean {
    try {
        const version = execFileSync(command, ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
        }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return false;
        const [, ver] = match;
        const [major, minor] = ver.split('.').map(Number);
        // app-server available in recent versions
        return major > 0 || minor >= 100;
    } catch {
        return false;
    }
}

function buildCodexProcessEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string' && !key.startsWith('HAPPY_RECONNECT_')) {
            env[key] = value;
        }
    }

    const codexProxy = env.HAPPY_CODEX_PROXY_URL || env.CODEX_PROXY_URL;
    if (codexProxy) {
        env.HTTP_PROXY = codexProxy;
        env.HTTPS_PROXY = codexProxy;
        env.ALL_PROXY = codexProxy;
        env.http_proxy = codexProxy;
        env.https_proxy = codexProxy;
        env.all_proxy = codexProxy;
    }

    return env;
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

export class CodexAppServerClient {
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private socket: WebSocket | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;
    private serviceTier: 'standard' | 'fast' = 'standard';

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    private threadDefaults: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    } | null = null;

    // Turn completion tracking for the currently active sendTurnAndWait call.
    // A completion event only resolves once we have seen task_started for this turn.
    private pendingTurnCompletion: {
        resolve: (aborted: boolean) => void;
        turnId: string | null;
    } | null = null;

    // Tracks in-flight interruptTurn() RPCs so sendTurnAndWait can wait for them
    // before starting a new turn (prevents stale turn/interrupt from aborting the next turn).
    private pendingInterrupt: Promise<void> | null = null;
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private startedTurnIds = new Set<string>();
    private completedTurnIds = new Set<string>();
    private pawsStartedTurnIds = new Set<string>();
    private pendingPawsTurnStart: {
        prompt: string;
        deferredUserItems: Array<{
            content: unknown;
            itemId: unknown;
            turnId: string | null;
        }>;
    } | null = null;
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;

    constructor(
        sandboxConfig?: SandboxConfig,
        private readonly connection: CodexAppServerConnection = { type: 'spawn' },
    ) {
        this.sandboxConfig = sandboxConfig;
    }

    get threadId(): string | null {
        return this._threadId;
    }

    get turnId(): string | null {
        return this._turnId;
    }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    setApprovalHandler(handler: ApprovalHandler): void {
        this.approvalHandler = handler;
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private extractThreadId(params: any): string | null {
        const threadId = params?.threadId ?? params?.thread?.id ?? null;
        return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
    }

    private isRootThreadNotification(params: any): boolean {
        const threadId = this.extractThreadId(params);
        return !threadId || !this._threadId || threadId === this._threadId;
    }

    private childEventScope(params: any): { subagent?: string } {
        const threadId = this.extractThreadId(params);
        return threadId && this._threadId && threadId !== this._threadId
            ? { subagent: threadId }
            : {};
    }

    private userMessageText(content: unknown): string | null {
        if (!Array.isArray(content)) return null;
        const text = content
            .filter((item): item is { type: 'text'; text: string } => (
                item?.type === 'text' && typeof item.text === 'string'
            ))
            .map((item) => item.text)
            .join('\n');
        return text.length > 0 ? text : null;
    }

    private rememberPawsStartedTurn(turnId: string): void {
        this.pawsStartedTurnIds.add(turnId);
        const oldest = this.pawsStartedTurnIds.values().next().value;
        if (this.pawsStartedTurnIds.size > 256 && typeof oldest === 'string') {
            this.pawsStartedTurnIds.delete(oldest);
        }
    }

    private emitExternalUserItem(item: { content: unknown; itemId: unknown; turnId: string | null }): void {
        this.eventHandler?.({
            type: 'user_message',
            content: item.content,
            item_id: item.itemId,
            turn_id: item.turnId,
        });
    }

    private settlePawsTurnStart(turnId: string | null, accepted: boolean): void {
        const pending = this.pendingPawsTurnStart;
        this.pendingPawsTurnStart = null;
        if (!pending) return;

        if (accepted && turnId) {
            this.rememberPawsStartedTurn(turnId);
        }
        for (const item of pending.deferredUserItems) {
            if (!accepted || !turnId || item.turnId !== turnId) {
                this.emitExternalUserItem(item);
            }
        }
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = method === 'thread/started'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/settings/updated'
            || method === 'thread/status/changed'
            || method === 'thread/tokenUsage/updated'
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

    private emitRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        const aborted = status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';

        this.tryResolvePendingTurn(aborted, turnId, source);
        this._turnId = null;

        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }
        if (turnId) {
            this.completedTurnIds.add(turnId);
        }

        if (aborted) {
            this.eventHandler?.({
                type: 'turn_aborted',
                ...(turnId ? { turn_id: turnId } : {}),
                ...(status ? { status } : {}),
                ...(error !== undefined && error !== null ? { error } : {}),
            });
            return;
        }

        this.eventHandler?.({
            type: 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(error !== undefined && error !== null ? { error } : {}),
        });
    }

    private emitTaskStarted(turnId: string | null, event?: EventMsg): void {
        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }
        if (turnId && this.startedTurnIds.has(turnId)) {
            return;
        }
        if (turnId) {
            this._turnId = turnId;
            this.startedTurnIds.add(turnId);
        }
        this.markPendingTurnStarted(turnId);
        this.eventHandler?.(event ?? {
            type: 'task_started',
            ...(turnId ? { turn_id: turnId } : {}),
        });
    }

    private handleRawNotification(method: string, params: any): boolean {
        if (!this.shouldHandleRawNotification(method)) {
            return false;
        }

        if (method === 'turn/started') {
            if (!this.isRootThreadNotification(params)) {
                return true;
            }
            const turnId = this.extractTurnId(params);
            this.emitTaskStarted(turnId);
            return true;
        }

        if (method === 'turn/completed') {
            if (!this.isRootThreadNotification(params)) {
                const threadId = this.extractThreadId(params);
                if (threadId) {
                    this.eventHandler?.({
                        type: 'subagent_completed',
                        subagent: threadId,
                        status: this.extractTurnStatus(params),
                        error: params?.turn?.error ?? params?.error,
                    });
                }
                return true;
            }
            this.emitRawTurnCompletion(
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
                method,
            );
            return true;
        }

        if (method === 'thread/settings/updated') {
            if (!this.isRootThreadNotification(params)) {
                return true;
            }
            const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
            const threadSettings = params?.threadSettings as ThreadSettings | undefined;
            if (threadSettings && typeof threadSettings.model === 'string') {
                this.eventHandler?.({
                    type: 'thread_settings_updated',
                    ...(threadId ? { thread_id: threadId } : {}),
                    thread_settings: threadSettings,
                });
            }
            return true;
        }

        if (method === 'thread/status/changed') {
            // A parent thread may become idle while spawned agents are still running.
            // Only turn/completed (or a root final answer fallback) is authoritative
            // enough to close the Happy turn.
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            if (!this.isRootThreadNotification(params)) {
                return true;
            }
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.eventHandler?.({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            return method.startsWith('item/');
        }

        const rootTurnId = this.isRootThreadNotification(params) ? this.extractTurnId(params) : null;
        const eventScope = {
            ...this.childEventScope(params),
            ...(rootTurnId ? { turn_id: rootTurnId } : {}),
        };

        if (method === 'item/completed' && item.type === 'userMessage') {
            // A turn submitted through this Bridge already exists in Paws as the
            // incoming user message. Only mirror user items created by another
            // client of the shared app-server (for example Codex Desktop).
            if (!this.isRootThreadNotification(params)) {
                return true;
            }
            const userItem = {
                content: item.content,
                itemId: item.id,
                turnId: this.extractTurnId(params),
            };
            if (userItem.turnId && this.pawsStartedTurnIds.has(userItem.turnId)) {
                return true;
            }
            const pendingStart = this.pendingPawsTurnStart;
            if (pendingStart && this.userMessageText(item.content) === pendingStart.prompt) {
                // The app-server may publish the item before replying to turn/start.
                // Defer only this matching candidate until the authoritative turn
                // ID arrives, so an overlapping Desktop turn is not hidden.
                pendingStart.deferredUserItems.push(userItem);
                return true;
            }
            this.emitExternalUserItem(userItem);
            return true;
        }

        if (method === 'item/completed' && item.type === 'subAgentActivity') {
            const kind = item.kind;
            const agentThreadId = typeof item.agentThreadId === 'string'
                ? item.agentThreadId
                : (typeof item.agent_thread_id === 'string' ? item.agent_thread_id : null);

            if (kind === 'started' && agentThreadId) {
                const callId = typeof item.id === 'string' ? item.id : '';
                const agentPath = typeof item.agentPath === 'string'
                    ? item.agentPath
                    : (typeof item.agent_path === 'string' ? item.agent_path : null);
                const common = {
                    call_id: callId,
                    callId,
                    tool: 'spawnAgent',
                    receiver_thread_ids: [agentThreadId],
                    prompt: agentPath,
                    agent_path: agentPath,
                    ...eventScope,
                };
                this.eventHandler?.({
                    type: 'collab_agent_tool_begin',
                    ...common,
                });
                this.eventHandler?.({
                    type: 'collab_agent_tool_end',
                    ...common,
                    status: 'completed',
                });
            }
            return true;
        }

        if (item.type === 'collabAgentToolCall') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const receiverThreadIds = Array.isArray(item.receiverThreadIds)
                ? item.receiverThreadIds.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
                : [];
            const common = {
                call_id: callId,
                callId,
                tool: item.tool,
                sender_thread_id: item.senderThreadId,
                receiver_thread_ids: receiverThreadIds,
                prompt: item.prompt,
                model: item.model,
                reasoning_effort: item.reasoningEffort,
                agents_states: item.agentsStates,
                ...eventScope,
            };

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'collab_agent_tool_begin',
                    ...common,
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'collab_agent_tool_end',
                    ...common,
                    status: item.status,
                });
                return true;
            }
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
                ...eventScope,
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
                ...eventScope,
            });
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
                    ...eventScope,
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'patch_apply_end',
                    call_id: callId,
                    callId,
                    status: item.status,
                    ...eventScope,
                });

                if (callId && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
                    this.rawFileChangesByItemId.delete(callId);
                }
                return true;
            }
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            const text = typeof item.text === 'string' ? item.text : '';
            const turnId = this.extractTurnId(params);
            if (text.length > 0) {
                this.eventHandler?.({
                    type: 'agent_message',
                    message: text,
                    item_id: item.id,
                    phase: item.phase,
                    ...(turnId ? { turn_id: turnId } : {}),
                    ...eventScope,
                });
            }

            if (this.isRootThreadNotification(params) && item.phase === 'final_answer' && this.pendingTurnCompletion) {
                this.emitRawTurnCompletion(
                    turnId,
                    'completed',
                    null,
                    `${method}:final_answer`,
                );
            }
            return true;
        }

        if (method === 'item/completed' && item.type === 'exitedReviewMode') {
            const review = typeof item.review === 'string' ? item.review : '';
            const turnId = this.extractTurnId(params);
            if (review.length > 0) {
                this.eventHandler?.({
                    type: 'agent_message',
                    message: review,
                    item_id: item.id,
                    phase: 'final_answer',
                    ...(turnId ? { turn_id: turnId } : {}),
                    ...eventScope,
                });
            }

            if (this.isRootThreadNotification(params) && this.pendingTurnCompletion) {
                this.emitRawTurnCompletion(
                    turnId,
                    'completed',
                    null,
                    `${method}:exitedReviewMode`,
                );
            }
            return true;
        }

        return method.startsWith('item/');
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;

        if (this.connection.type === 'unixSocket') {
            try {
                await this.connectUnixSocket(this.connection);
                await this.initializeConnection();
            } catch (error) {
                await this.disconnectInternal();
                throw error;
            }
            return;
        }

        const codexCommand = resolveCodexExecutablePath();
        if (!isAppServerAvailable(codexCommand)) {
            throw new Error(
                'Codex CLI is not installed\n\n' +
                'Please install Codex CLI using one of these methods:\n\n' +
                'Option 1 - npm (recommended):\n  npm install -g @openai/codex\n\n' +
                'Option 2 - Homebrew (macOS):\n  brew install --cask codex\n\n' +
                'Alternatively, use Claude Code:\n  happy claude',
            );
        }

        let command = codexCommand;
        let args = ['app-server', '--listen', 'stdio://', '-c', `service_tier=\"${this.serviceTier}\"`];
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
                const wrapped = await wrapForMcpTransport(codexCommand, args);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                logger.warn('[CodexAppServer] Failed to initialize sandbox; continuing without.', error);
                this.sandboxCleanup = null;
            }
        }

        // Build env — same filtering as the old MCP client, with Codex-specific proxy isolation.
        const env = buildCodexProcessEnv();
        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        if (this.sandboxEnabled) {
            env.CODEX_SANDBOX = 'seatbelt';
        }

        logger.debug(`[CodexAppServer] Spawning: ${command} ${args.join(' ')}`);

        const epoch = ++this.processEpoch;
        // Use cross-spawn so npm-installed wrappers (codex.cmd / codex.ps1) resolve on Windows.
        // Native child_process.spawn fails with ENOENT for .cmd shims (issues #980, #1016).
        const proc = crossSpawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
        });
        this.process = proc;

        proc.on('error', (err) => {
            logger.debug('[CodexAppServer] Process error:', err);
        });

        proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            // Ignore stale process exits from prior generations during reconnect.
            if (this.process !== proc || this.processEpoch !== epoch) {
                logger.debug('[CodexAppServer] Ignoring stale process exit');
                return;
            }
            this.connected = false;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
                this.pending.delete(id);
            }
            // Resolve pending turn completion (treat as abort)
            this.resolvePendingTurn(true);
        });

        // Pipe stderr for debug logging
        proc.stderr?.on('data', (chunk: Buffer) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            const text = chunk.toString().trim();
            if (text) logger.debug(`[CodexAppServer:stderr] ${text}`);
        });

        // Parse newline-delimited JSON from stdout
        this.readline = createInterface({ input: proc.stdout! });
        this.readline.on('line', (line) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            this.handleLine(line, epoch);
        });

        await this.initializeConnection();
    }

    private async connectUnixSocket(
        connection: Extract<CodexAppServerConnection, { type: 'unixSocket' }>,
    ): Promise<void> {
        this.sandboxEnabled = false;
        if (this.sandboxConfig?.enabled) {
            logger.warn('[CodexAppServer] Client sandbox is ignored when using a shared app-server');
        }

        const epoch = ++this.processEpoch;
        const socketUrl = `ws+unix://${connection.socketPath}:/`;
        const socket = new WebSocket(socketUrl, {
            handshakeTimeout: connection.connectTimeoutMs ?? 5_000,
            perMessageDeflate: false,
        });
        this.socket = socket;

        socket.on('message', (data, isBinary) => {
            if (this.socket !== socket || this.processEpoch !== epoch) return;
            if (isBinary) {
                logger.warn('[CodexAppServer] Ignoring unexpected binary message from shared app-server');
                return;
            }
            this.handleLine(data.toString(), epoch);
        });
        socket.on('error', (error) => {
            if (this.socket !== socket || this.processEpoch !== epoch) return;
            logger.debug('[CodexAppServer] Shared socket error:', error);
        });
        socket.on('close', (code, reason) => {
            if (this.socket !== socket || this.processEpoch !== epoch) return;
            this.socket = null;
            this.connected = false;
            for (const [id, request] of this.pending) {
                if (request.epoch !== epoch) continue;
                request.reject(new Error(
                    `Shared Codex app-server connection closed (${code}${reason.length > 0 ? `: ${reason.toString()}` : ''}) while waiting for ${request.method}`,
                ));
                this.pending.delete(id);
            }
            this.resolvePendingTurn(true);
        });

        await new Promise<void>((resolve, reject) => {
            const handleOpen = (): void => {
                socket.off('error', handleConnectError);
                socket.off('close', handleConnectClose);
                resolve();
            };
            const handleConnectError = (error: Error): void => {
                socket.off('open', handleOpen);
                socket.off('close', handleConnectClose);
                reject(new Error(`Unable to connect to shared Codex app-server at ${connection.socketPath}: ${error.message}`));
            };
            const handleConnectClose = (): void => {
                socket.off('open', handleOpen);
                socket.off('error', handleConnectError);
                reject(new Error(`Shared Codex app-server closed before initialization at ${connection.socketPath}`));
            };
            socket.once('open', handleOpen);
            socket.once('error', handleConnectError);
            socket.once('close', handleConnectClose);
        });

        logger.debug(`[CodexAppServer] Connected to shared Unix socket: ${connection.socketPath}`);
    }

    private async initializeConnection(): Promise<void> {
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
        await this.request('initialize', initParams);
        this.notify('initialized');
        this.connected = true;
        logger.debug('[CodexAppServer] Connected and initialized');
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        if (!this.connected && !this.process && !this.socket) return;

        const proc = this.process;
        const socket = this.socket;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'} shared=${socket !== null}`);

        this.readline?.close();
        this.readline = null;
        this.socket = null;

        try {
            proc?.stdin?.end();
            proc?.kill('SIGTERM');
        } catch { /* ignore */ }

        // Force kill after 2s (unref so timer doesn't block process exit)
        if (pid) {
            const killTimer = setTimeout(() => {
                try {
                    process.kill(pid, 0); // check alive
                    process.kill(pid, 'SIGKILL');
                } catch { /* already dead */ }
            }, 2000);
            killTimer.unref();
        }

        if (socket) {
            await new Promise<void>((resolve) => {
                if (socket.readyState === WebSocket.CLOSED) {
                    resolve();
                    return;
                }
                const timer = setTimeout(resolve, 1_000);
                timer.unref();
                socket.once('close', () => {
                    clearTimeout(timer);
                    resolve();
                });
                if (socket.readyState === WebSocket.CONNECTING) {
                    socket.terminate();
                } else {
                    socket.close(1000, 'Paws client disconnected');
                }
            });
        }

        this.process = null;
        this.connected = false;
        this._turnId = null;
        this.notificationProtocol = 'unknown';
        this.startedTurnIds.clear();
        this.completedTurnIds.clear();
        this.settlePawsTurnStart(null, false);
        if (!opts?.preserveThreadState) {
            this._threadId = null;
            this.threadDefaults = null;
            this.pawsStartedTurnIds.clear();
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
            this.pending.delete(id);
        }

        // Resolve pending turn completion (treat as abort)
        this.resolvePendingTurn(true);

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        logger.debug('[CodexAppServer] Disconnected');
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): Record<string, unknown> | null {
        return mcpServers ? { mcp_servers: mcpServers } : null;
    }

    private rememberThreadDefaults(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
        };
    }

    async listModels(opts?: ModelListParams): Promise<ModelListResponse> {
        const params: ModelListParams = {
            cursor: opts?.cursor ?? null,
            includeHidden: opts?.includeHidden ?? null,
            limit: opts?.limit ?? null,
        };
        return await this.request('model/list', params) as ModelListResponse;
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string; reasoningEffort: ReasoningEffort | null }> {
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: true,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults({
            ...opts,
            model: opts.model ?? result.model,
        });
        logger.debug('[CodexAppServer] Thread started:', this._threadId);
        return { threadId: result.thread.id, model: result.model, reasoningEffort: result.reasoningEffort };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string; reasoningEffort: ReasoningEffort | null }> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const defaults = this.threadDefaults ?? {};
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/resume', params) as ResumeConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults({
            model: opts?.model ?? defaults.model ?? result.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread resumed:', this._threadId);
        return { threadId: result.thread.id, model: result.model, reasoningEffort: result.reasoningEffort };
    }

    async forkThread(opts: {
        threadId: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string; thread: Thread }> {
        const defaults = this.threadDefaults ?? {};
        const params: ForkConversationParams = {
            threadId: opts.threadId,
            model: opts.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            ephemeral: false,
            threadSource: null,
        };

        const result = await this.request('thread/fork', params) as ForkConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults({
            model: opts.model ?? defaults.model,
            cwd: opts.cwd ?? defaults.cwd,
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts.sandbox ?? defaults.sandbox,
            mcpServers: opts.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread forked:', opts.threadId, '->', this._threadId);
        return { threadId: result.thread.id, model: result.model, thread: result.thread };
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

    async listThreads(opts: ThreadListParams = {}): Promise<ThreadListResponse> {
        return await this.request('thread/list', opts) as ThreadListResponse;
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

    async setThreadGoal(opts: {
        threadId?: string;
        objective?: string | null;
        status?: ThreadGoalStatus | null;
        tokenBudget?: number | null;
    }): Promise<ThreadGoalSetResponse> {
        const threadId = opts.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to set a goal.');
        }

        const params: Record<string, unknown> = { threadId };
        if (opts.objective !== undefined) params.objective = opts.objective;
        if (opts.status !== undefined) params.status = opts.status;
        if (opts.tokenBudget !== undefined) params.tokenBudget = opts.tokenBudget;

        return await this.request('thread/goal/set', params) as ThreadGoalSetResponse;
    }

    async getThreadGoal(opts?: { threadId?: string }): Promise<ThreadGoalGetResponse> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to read a goal.');
        }

        return await this.request('thread/goal/get', { threadId }) as ThreadGoalGetResponse;
    }

    async clearThreadGoal(opts?: { threadId?: string }): Promise<ThreadGoalClearResponse> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to clear a goal.');
        }

        return await this.request('thread/goal/clear', { threadId }) as ThreadGoalClearResponse;
    }

    async readAccountUsage(): Promise<GetAccountTokenUsageResponse> {
        return await this.request('account/usage/read') as GetAccountTokenUsageResponse;
    }

    async listMcpServerStatus(opts?: ListMcpServerStatusParams): Promise<ListMcpServerStatusResponse> {
        const params: ListMcpServerStatusParams = {
            threadId: opts?.threadId ?? null,
            detail: opts?.detail ?? null,
            cursor: opts?.cursor ?? null,
            limit: opts?.limit ?? null,
        };
        return await this.request('mcpServerStatus/list', params) as ListMcpServerStatusResponse;
    }

    async startCompact(opts?: { threadId?: string }): Promise<ThreadCompactStartResponse> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to compact.');
        }

        return await this.request('thread/compact/start', { threadId }) as ThreadCompactStartResponse;
    }

    async startReview(opts: ReviewStartParams): Promise<ReviewStartResponse> {
        return await this.request('review/start', opts) as ReviewStartResponse;
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        const threadId = this._threadId;
        await this.disconnectInternal({ preserveThreadState: !!threadId });
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

    async setServiceTier(tier: 'standard' | 'fast'): Promise<boolean> {
        if (tier === this.serviceTier) return false;
        this.serviceTier = tier;
        return await this.reconnectAndResumeThread();
    }

    // ─── Turn management ────────────────────────────────────────

    /** Default grace period after interrupt before forcing a restart (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;

    private hasPendingTurnCompletion(): boolean {
        return this.pendingTurnCompletion !== null;
    }

    private resolvePendingTurn(aborted: boolean): void {
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.resolve(aborted);
        this.pendingTurnCompletion = null;
    }

    private resolveTimedOutTurn(timeoutMs: number, label: string): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;

        const turnId = pending.turnId ?? this._turnId;
        const error = `${label} timed out after ${timeoutMs}ms`;
        logger.warn(`[CodexAppServer] ${error} — treating as failed abort`);

        this.resolvePendingTurn(true);
        this._turnId = null;
        if (turnId) {
            this.completedTurnIds.add(turnId);
        }
        this.eventHandler?.({
            type: 'turn_aborted',
            ...(turnId ? { turn_id: turnId } : {}),
            status: 'failed',
            reason: 'timeout',
            error,
        });
    }

    private markPendingTurnStarted(turnId?: string | null): void {
        if (!this.pendingTurnCompletion) return;
        if (turnId) {
            this.pendingTurnCompletion.turnId = turnId;
        }
    }

    private tryResolvePendingTurn(aborted: boolean, turnId: string | null, source: string): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;

        // Guard against stale completion notifications from a *different* turn.
        // We use turn ID matching instead of the `started` flag because Codex
        // can skip the turn/started notification entirely for fast turns,
        // which would cause us to discard a valid turn/completed and hang forever.
        if (pending.turnId && turnId && pending.turnId !== turnId) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; awaiting ${pending.turnId}`,
            );
            return;
        }

        this.resolvePendingTurn(aborted);
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
        const hadActiveTurn = this.hasPendingTurnCompletion();

        // No active turn pending in this client call-site.
        if (!hadActiveTurn) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }

        // Best-effort interrupt request first.
        await this.interruptTurn();

        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        const settled = await this.waitForTurnCompletion(gracePeriodMs);
        if (settled) {
            return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
        }

        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
        const pendingTurnId = this.pendingTurnCompletion?.turnId ?? this._turnId;
        if (this.pendingTurnCompletion) {
            this.eventHandler?.({
                type: 'turn_aborted',
                reason: 'interrupted',
                ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
                forced_restart: true,
            });
        }
        const resumedThread = await this.reconnectAndResumeThread();
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
        effort?: ReasoningEffort;
        images?: Array<{ type: 'localImage'; path: string }>;
    }): Promise<void> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        // Images first, then text — mirrors the Claude path's ordering and is
        // what Codex expects (visual context precedes the instruction).
        const input: InputItem[] = [
            ...(opts?.images ?? []),
            { type: 'text', text: prompt },
        ];

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId: this._threadId,
            input,
        };
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        if (opts?.model) params.model = opts.model;
        if (opts?.effort) params.effort = opts.effort;

        // Map sandbox mode to the camelCase policy format the server expects
        if (opts?.sandbox) {
            switch (opts.sandbox) {
                case 'workspace-write':
                    params.sandboxPolicy = { type: 'workspaceWrite' };
                    break;
                case 'danger-full-access':
                    params.sandboxPolicy = { type: 'dangerFullAccess' };
                    break;
                case 'read-only':
                    params.sandboxPolicy = { type: 'readOnly' };
                    break;
            }
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        this.pendingPawsTurnStart = { prompt, deferredUserItems: [] };
        try {
            const result = await this.request('turn/start', params) as { turn?: { id?: string | null } };
            const turnId = result?.turn?.id;
            const resolvedTurnId = typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
            this.settlePawsTurnStart(resolvedTurnId, true);
            if (resolvedTurnId) {
                if (this.pendingTurnCompletion) {
                    this.pendingTurnCompletion.turnId = resolvedTurnId;
                }
                // Some app-server versions accept a turn but omit turn/started and
                // legacy task_started notifications. The successful RPC response is
                // authoritative that work has begun, so keep session state live.
                this.emitTaskStarted(resolvedTurnId);
            }
        } catch (error) {
            this.settlePawsTurnStart(null, false);
            throw error;
        }
    }

    /** Default timeout for waiting on turn completion (ms). 10 minutes. */
    private static readonly TURN_TIMEOUT_MS = 10 * 60 * 1000;

    /**
     * Send a user turn and wait for it to complete (task_complete or turn_aborted).
     * Returns { aborted: true } if the turn was aborted (user cancel, permission reject, etc.).
     */
    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        turnTimeoutMs?: number;
        images?: Array<{ type: 'localImage'; path: string }>;
    }): Promise<{ aborted: boolean }> {
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

        const timeoutMs = opts?.turnTimeoutMs ?? CodexAppServerClient.TURN_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const completion = new Promise<boolean>((resolve) => {
            this.pendingTurnCompletion = {
                resolve,
                turnId: null,
            };

            timer = setTimeout(() => {
                this.resolveTimedOutTurn(timeoutMs, 'Turn');
            }, timeoutMs);
        });

        try {
            await this.sendTurn(prompt, opts);
        } catch (err) {
            if (timer) clearTimeout(timer);
            this.pendingTurnCompletion = null;
            throw err;
        }

        const aborted = await completion;
        if (timer) clearTimeout(timer);
        return { aborted };
    }

    private async waitForServerStartedTurn(
        start: () => Promise<{ turn?: { id?: string | null } } | Record<string, unknown>>,
        timeoutMs: number = CodexAppServerClient.TURN_TIMEOUT_MS,
    ): Promise<{ aborted: boolean }> {
        if (this.pendingInterrupt) {
            await this.pendingInterrupt;
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        let timer: ReturnType<typeof setTimeout> | null = null;
        const completion = new Promise<boolean>((resolve) => {
            this.pendingTurnCompletion = {
                resolve,
                turnId: null,
            };

            timer = setTimeout(() => {
                this.resolveTimedOutTurn(timeoutMs, 'Server-started turn');
            }, timeoutMs);
        });

        try {
            const result = await start();
            const turn = (result as { turn?: { id?: string | null } }).turn;
            const turnId = turn?.id;
            if (typeof turnId === 'string' && turnId.length > 0) {
                this._turnId = turnId;
                if (this.pendingTurnCompletion) {
                    this.pendingTurnCompletion.turnId = turnId;
                }
            }
        } catch (err) {
            if (timer) clearTimeout(timer);
            this.pendingTurnCompletion = null;
            throw err;
        }

        const aborted = await completion;
        if (timer) clearTimeout(timer);
        return { aborted };
    }

    async startCompactAndWait(opts?: {
        threadId?: string;
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
        return this.waitForServerStartedTurn(
            () => this.startCompact({ threadId: opts?.threadId }),
            opts?.turnTimeoutMs,
        );
    }

    async startReviewAndWait(opts: ReviewStartParams & {
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
        return this.waitForServerStartedTurn(
            () => this.startReview(opts),
            opts.turnTimeoutMs,
        );
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
                await this.request('turn/interrupt', params);
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
        this._threadId = null;
        this._turnId = null;
        this.threadDefaults = null;
        this.startedTurnIds.clear();
        this.completedTurnIds.clear();
        this.pawsStartedTurnIds.clear();
        this.settlePawsTurnStart(null, false);
        this.rawFileChangesByItemId.clear();
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.canWriteToTransport()) {
                reject(new Error(`Cannot send ${method}: Codex transport is not writable`));
                return;
            }
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
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            try {
                this.writeTransportMessage(JSON.stringify(msg));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private notify(method: string, params?: unknown): void {
        if (!this.canWriteToTransport()) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.writeTransportMessage(JSON.stringify(msg));
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private respond(id: number, result: unknown): void {
        if (!this.canWriteToTransport()) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.writeTransportMessage(JSON.stringify(msg));
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private canWriteToTransport(): boolean {
        return this.socket?.readyState === WebSocket.OPEN || this.process?.stdin?.writable === true;
    }

    private writeTransportMessage(message: string): void {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(message);
            return;
        }
        if (this.process?.stdin?.writable) {
            this.process.stdin.write(`${message}\n`);
            return;
        }
        throw new Error('Codex transport is not writable');
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
            this.handleServerRequest(msg.id, msg.method, msg.params).catch((err) => {
                logger.debug('[CodexAppServer] Error handling server request:', err);
            });
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.handleNotification(msg.method, msg.params);
            return;
        }

        logger.debug('[CodexAppServer] Unhandled message:', JSON.stringify(msg).substring(0, 300));
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

    private async handleServerRequest(id: number, method: string, params: any): Promise<void> {
        const isApprovalRequest = method === 'mcpServer/elicitation/request'
            || method === 'item/commandExecution/requestApproval'
            || method === 'execCommandApproval'
            || method === 'item/fileChange/requestApproval'
            || method === 'applyPatchApproval';
        const approvalAuthority = this.connection.type === 'unixSocket'
            ? (this.connection.approvalAuthority ?? 'desktop')
            : 'paws';
        if (isApprovalRequest && approvalAuthority === 'desktop') {
            logger.debug(`[CodexAppServer] Leaving ${method} for the Desktop approval authority`);
            return;
        }

        if (method === 'mcpServer/elicitation/request') {
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? params?.serverName ?? 'McpTool';
            const decision = await this.handleApproval({
                type: 'mcp',
                callId: `${params?.serverName ?? 'mcp'}:${id}`,
                toolName,
                input: params?._meta?.tool_params ?? {},
                serverName: params?.serverName,
                message: params?.message,
            });
            this.respond(id, this.mapDecisionToMcpElicitationResponse(decision, params));
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'exec',
                callId,
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'patch',
                callId,
                fileChanges: params.fileChanges ?? (typeof callId === 'string'
                    ? this.rawFileChangesByItemId.get(callId)
                    : undefined),
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug(`[CodexAppServer] Unknown server request: ${method}`);
        this.respond(id, {});
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
        // codex/event notifications: either `codex/event` or `codex/event/<type>`
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            if (msg) {
                // Extract turn_id from task_started events
                if (msg.type === 'task_started' && msg.turn_id) {
                    this._turnId = msg.turn_id;
                }
                if (msg.type === 'task_started') {
                    this.emitTaskStarted(msg.turn_id ?? msg.turnId ?? null, msg);
                } else {
                    // Fire event handler first (so consumer processes the event)
                    this.eventHandler?.(msg);
                }
                // Then resolve turn completion promise
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    const turnId = msg.turn_id ?? msg.turnId ?? null;
                    // Mark as completed so v2 turn/completed doesn't duplicate
                    if (turnId) {
                        this.completedTurnIds.add(turnId);
                    }
                    this.tryResolvePendingTurn(
                        msg.type === 'turn_aborted',
                        turnId,
                        `codex/event/${msg.type}`,
                    );
                    this._turnId = null;
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
            if (!this.isRootThreadNotification(params)) {
                return;
            }
            // Mark the turn as started so the completion guard lets it through.
            if (method === 'turn/started') {
                const turnId = this.extractTurnId(params);
                if (turnId) {
                    this._turnId = turnId;
                }
                this.markPendingTurnStarted(turnId);
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
            return;
        }

        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
