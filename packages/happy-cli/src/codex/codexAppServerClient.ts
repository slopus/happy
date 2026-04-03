import { randomUUID } from 'node:crypto';
import {
    Codex,
    type ApprovalMode,
    type CommandExecutionItem,
    type FileChangeItem,
    type McpToolCallItem,
    type ModelReasoningEffort,
    type ReasoningItem,
    type SandboxMode as SdkSandboxMode,
    type Thread,
    type ThreadEvent,
    type ThreadItem,
    type TodoListItem,
    type WebSearchItem,
} from '@openai/codex-sdk';
import { logger } from '@/ui/logger';
import type {
    ApprovalPolicy,
    EventMsg,
    ReasoningEffort,
    SandboxMode,
    ReviewDecision,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';

type PendingTurn = {
    controller: AbortController;
    promise: Promise<{ aborted: boolean }>;
    turnId: string;
};

type PendingThreadOptions = {
    model?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    mcpServers?: Record<string, unknown>;
    effort?: ReasoningEffort;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

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

type ResolvedModel = {
    model: string | undefined;
    effort: ModelReasoningEffort | undefined;
    reportedModel: string;
};

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | { [key: string]: CodexConfigValue };

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
        if (typeof change.diff === 'string') {
            entry.diff = change.diff;
        }
        if (change.kind && typeof change.kind === 'object' && !Array.isArray(change.kind)) {
            entry.kind = change.kind;
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export class CodexAppServerClient {
    private connected = false;
    private codex: Codex | null = null;
    private codexConfigKey = '';
    private thread: Thread | null = null;
    private pendingTurn: PendingTurn | null = null;
    private threadDefaults: PendingThreadOptions | null = null;
    private startedItems = new Set<string>();
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;

    constructor(private readonly sandboxConfig?: SandboxConfig) {}

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

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;
        if (this.sandboxConfig?.enabled) {
            logger.warn('[Codex] External Happy sandbox wrapping is not supported on the SDK exec transport; using native Codex sandbox controls only.');
        }
        this.connected = true;
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        this.pendingTurn?.controller.abort();
        this.pendingTurn = null;
        this.startedItems.clear();
        this.thread = null;
        this.codex = null;
        this.codexConfigKey = '';
        this.connected = false;
        this._turnId = null;
        if (!opts?.preserveThreadState) {
            this._threadId = null;
            this.threadDefaults = null;
        }
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    private rememberThreadDefaults(opts: PendingThreadOptions): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
            effort: opts.effort,
        };
    }

    private ensureCodex(mcpServers?: Record<string, unknown>): Codex {
        const key = JSON.stringify(mcpServers ?? {});
        if (this.codex && this.codexConfigKey === key) {
            return this.codex;
        }

        const env: Record<string, string> = {};
        for (const [envKey, envValue] of Object.entries(process.env)) {
            if (typeof envValue === 'string') {
                env[envKey] = envValue;
            }
        }
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }

        const config: { [key: string]: CodexConfigValue } = {};
        const serializedMcpServers = serializeCodexConfigValue(mcpServers);
        if (serializedMcpServers && !Array.isArray(serializedMcpServers)) {
            config.mcp_servers = serializedMcpServers;
        }

        this.codex = new Codex({
            env,
            ...(Object.keys(config).length > 0 ? { config } : {}),
        });
        this.codexConfigKey = key;
        return this.codex;
    }

    private resolveModel(model?: string): ResolvedModel {
        if (!model) {
            return {
                model: undefined,
                effort: undefined,
                reportedModel: 'default',
            };
        }

        if (model === 'codex-mini-latest') {
            return {
                model: 'gpt-5-codex',
                effort: 'high',
                reportedModel: 'gpt-5-codex',
            };
        }

        if (model === 'o3-mini') {
            return {
                model: 'gpt-5',
                effort: 'high',
                reportedModel: 'gpt-5',
            };
        }

        if (model === 'gpt-5' || model === 'gpt-5-codex') {
            return {
                model,
                effort: 'high',
                reportedModel: model,
            };
        }

        return {
            model,
            effort: undefined,
            reportedModel: model,
        };
    }

    private resolveEffort(modelEffort: ReasoningEffort | undefined, model: string | undefined): ModelReasoningEffort | undefined {
        if (modelEffort === 'minimal' || modelEffort === 'low' || modelEffort === 'medium' || modelEffort === 'high' || modelEffort === 'xhigh') {
            return modelEffort;
        }
        return this.resolveModel(model).effort;
    }

    private buildThreadOptions(opts: PendingThreadOptions): {
        model?: string;
        sandboxMode?: SdkSandboxMode;
        workingDirectory?: string;
        skipGitRepoCheck: boolean;
        modelReasoningEffort?: ModelReasoningEffort;
        networkAccessEnabled: boolean;
        webSearchEnabled: boolean;
        approvalPolicy?: ApprovalMode;
    } {
        const resolvedModel = this.resolveModel(opts.model);
        const modelReasoningEffort = this.resolveEffort(opts.effort, resolvedModel.model);
        return {
            ...(resolvedModel.model ? { model: resolvedModel.model } : {}),
            ...(opts.sandbox ? { sandboxMode: opts.sandbox as SdkSandboxMode } : {}),
            ...(opts.cwd ? { workingDirectory: opts.cwd } : {}),
            skipGitRepoCheck: true,
            ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
            networkAccessEnabled: opts.sandbox !== 'read-only',
            webSearchEnabled: true,
            ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy as ApprovalMode } : {}),
        };
    }

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        this.rememberThreadDefaults(opts);
        this.thread = this.ensureCodex(opts.mcpServers).startThread(this.buildThreadOptions(opts));
        this._threadId = this.thread.id;
        this._turnId = null;
        return {
            threadId: this._threadId ?? '',
            model: this.resolveModel(opts.model).reportedModel,
        };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const defaults = this.threadDefaults ?? {};
        const merged = {
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
            effort: defaults.effort,
        };

        this.rememberThreadDefaults(merged);
        this.thread = this.ensureCodex(merged.mcpServers).resumeThread(threadId, this.buildThreadOptions(merged));
        this._threadId = threadId;
        this._turnId = null;

        return {
            threadId,
            model: this.resolveModel(merged.model).reportedModel,
        };
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        const threadId = this._threadId;
        await this.disconnectInternal({ preserveThreadState: Boolean(threadId) });
        await this.connect();
        if (!threadId) {
            return false;
        }
        await this.resumeThread({ threadId });
        return true;
    }

    hasActiveThread(): boolean {
        return this.thread !== null;
    }

    private emitEvent(message: EventMsg): void {
        this.eventHandler?.(message);
    }

    private normalizeFileChanges(item: FileChangeItem): Record<string, unknown> {
        const changes: Record<string, unknown> = {};
        for (const change of item.changes) {
            changes[change.path] = change;
        }
        return changes;
    }

    private emitPatchBegin(item: FileChangeItem): void {
        this.emitEvent({
            type: 'patch_apply_begin',
            call_id: item.id,
            callId: item.id,
            changes: this.normalizeFileChanges(item),
            status: item.status,
        });
    }

    private emitPatchEnd(item: FileChangeItem): void {
        this.emitEvent({
            type: 'patch_apply_end',
            call_id: item.id,
            callId: item.id,
            changes: this.normalizeFileChanges(item),
            status: item.status,
            success: item.status === 'completed',
            stdout: item.changes.map((change) => `${change.kind} ${change.path}`).join('\n'),
        });
    }

    private emitCommandBegin(item: CommandExecutionItem): void {
        this.emitEvent({
            type: 'exec_command_begin',
            call_id: item.id,
            callId: item.id,
            command: item.command,
            description: item.command,
        });
    }

    private emitCommandEnd(item: CommandExecutionItem): void {
        this.emitEvent({
            type: 'exec_command_end',
            call_id: item.id,
            callId: item.id,
            command: item.command,
            output: item.aggregated_output,
            stdout: item.aggregated_output,
            exit_code: item.exit_code ?? null,
            exitCode: item.exit_code ?? null,
            status: item.status,
        });
    }

    private emitToolStart(item: McpToolCallItem | WebSearchItem): void {
        const name = item.type === 'web_search' ? 'web_search' : item.tool;
        const input = item.type === 'web_search'
            ? { query: item.query }
            : { server: item.server, arguments: item.arguments };

        this.emitEvent({
            type: 'tool-call',
            call_id: item.id,
            callId: item.id,
            name,
            input,
        });
    }

    private emitToolEnd(item: McpToolCallItem | WebSearchItem): void {
        const output = item.type === 'web_search'
            ? { status: 'completed', content: item.query }
            : item.error
                ? { status: 'error', content: item.error.message }
                : { status: 'completed', content: JSON.stringify(item.result ?? {}) };

        this.emitEvent({
            type: 'tool-call-result',
            call_id: item.id,
            callId: item.id,
            output,
        });
    }

    private handleThreadItem(item: ThreadItem, lifecycle: 'started' | 'updated' | 'completed'): void {
        switch (item.type) {
            case 'agent_message':
                if (lifecycle === 'completed' && item.text.length > 0) {
                    this.emitEvent({ type: 'agent_message', message: item.text, item_id: item.id });
                }
                return;
            case 'reasoning': {
                const reasoning = item as ReasoningItem;
                if (lifecycle === 'completed' && reasoning.text.length > 0) {
                    this.emitEvent({ type: 'reasoning', message: reasoning.text, item_id: reasoning.id });
                }
                return;
            }
            case 'command_execution': {
                const commandItem = item as CommandExecutionItem;
                if (lifecycle === 'started') {
                    this.startedItems.add(commandItem.id);
                    this.emitCommandBegin(commandItem);
                    return;
                }
                if (lifecycle === 'completed') {
                    if (!this.startedItems.has(commandItem.id)) {
                        this.emitCommandBegin(commandItem);
                    }
                    this.startedItems.delete(commandItem.id);
                    this.emitCommandEnd(commandItem);
                }
                return;
            }
            case 'file_change': {
                const fileItem = item as FileChangeItem;
                if (lifecycle === 'started') {
                    this.startedItems.add(fileItem.id);
                    this.emitPatchBegin(fileItem);
                    return;
                }
                if (lifecycle === 'completed') {
                    if (!this.startedItems.has(fileItem.id)) {
                        this.emitPatchBegin(fileItem);
                    }
                    this.startedItems.delete(fileItem.id);
                    this.emitPatchEnd(fileItem);
                }
                return;
            }
            case 'mcp_tool_call':
                if (lifecycle === 'started') {
                    this.startedItems.add(item.id);
                    this.emitToolStart(item);
                    return;
                }
                if (lifecycle === 'completed') {
                    if (!this.startedItems.has(item.id)) {
                        this.emitToolStart(item);
                    }
                    this.startedItems.delete(item.id);
                    this.emitToolEnd(item);
                }
                return;
            case 'web_search':
                if (lifecycle === 'started') {
                    this.startedItems.add(item.id);
                    this.emitToolStart(item);
                    return;
                }
                if (lifecycle === 'completed') {
                    if (!this.startedItems.has(item.id)) {
                        this.emitToolStart(item);
                    }
                    this.startedItems.delete(item.id);
                    this.emitToolEnd(item);
                }
                return;
            case 'todo_list': {
                const todoItem = item as TodoListItem;
                if (lifecycle === 'completed' && todoItem.items.length > 0) {
                    const summary = todoItem.items
                        .map((entry) => `${entry.completed ? '[x]' : '[ ]'} ${entry.text}`)
                        .join('\n');
                    this.emitEvent({ type: 'agent_message', message: summary, item_id: todoItem.id });
                }
                return;
            }
            case 'error':
                if (lifecycle === 'completed' && item.message.length > 0) {
                    this.emitEvent({ type: 'agent_message', message: item.message, item_id: item.id });
                }
                return;
        }
    }

    private async prepareTurn(opts: PendingThreadOptions): Promise<void> {
        const merged = {
            model: opts.model ?? this.threadDefaults?.model,
            cwd: opts.cwd ?? this.threadDefaults?.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? this.threadDefaults?.approvalPolicy,
            sandbox: opts.sandbox ?? this.threadDefaults?.sandbox,
            mcpServers: opts.mcpServers ?? this.threadDefaults?.mcpServers,
            effort: opts.effort ?? this.threadDefaults?.effort,
        };

        this.rememberThreadDefaults(merged);
        const codex = this.ensureCodex(merged.mcpServers);
        const threadOptions = this.buildThreadOptions(merged);

        if (this._threadId) {
            this.thread = codex.resumeThread(this._threadId, threadOptions);
        } else {
            this.thread = codex.startThread(threadOptions);
        }
    }

    private async sendTurn(opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
    }): Promise<void> {
        await this.prepareTurn({
            model: opts?.model,
            cwd: opts?.cwd,
            approvalPolicy: opts?.approvalPolicy,
            sandbox: opts?.sandbox,
            effort: opts?.effort,
        });
    }

    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
        await this.sendTurn(opts);

        if (!this.thread) {
            throw new Error('No active thread. Call startThread first.');
        }

        const controller = new AbortController();
        const timeoutMs = opts?.turnTimeoutMs ?? 10 * 60 * 1000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const turnId = `turn_${randomUUID()}`;
        this._turnId = turnId;

        const runPromise = (async () => {
            try {
                const { events } = await this.thread!.runStreamed(prompt, { signal: controller.signal });
                for await (const event of events) {
                    await this.handleThreadEvent(event, turnId);
                }
                return { aborted: false };
            } catch (error) {
                if (controller.signal.aborted) {
                    this.emitEvent({ type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
                    return { aborted: true };
                }

                const message = error instanceof Error ? error.message : String(error);
                logger.warn('[Codex] SDK turn failed', error);
                this.emitEvent({ type: 'agent_message', message });
                this.emitEvent({ type: 'task_complete', turn_id: turnId, status: 'error', error: message });
                return { aborted: false };
            } finally {
                clearTimeout(timer);
                this._turnId = null;
                if (this.pendingTurn?.turnId === turnId) {
                    this.pendingTurn = null;
                }
                this.startedItems.clear();
            }
        })();

        this.pendingTurn = {
            controller,
            promise: runPromise,
            turnId,
        };

        return runPromise;
    }

    private async handleThreadEvent(event: ThreadEvent, turnId: string): Promise<void> {
        switch (event.type) {
            case 'thread.started':
                this._threadId = event.thread_id;
                this.emitEvent({ type: 'thread_started', thread_id: event.thread_id });
                return;
            case 'turn.started':
                this.emitEvent({ type: 'task_started', turn_id: turnId });
                return;
            case 'turn.completed':
                this.emitEvent({ type: 'token_count', ...event.usage });
                this.emitEvent({ type: 'task_complete', turn_id: turnId, status: 'completed' });
                return;
            case 'turn.failed':
                this.emitEvent({ type: 'task_complete', turn_id: turnId, status: 'error', error: event.error.message });
                return;
            case 'item.started':
                this.handleThreadItem(event.item, 'started');
                return;
            case 'item.updated':
                this.handleThreadItem(event.item, 'updated');
                return;
            case 'item.completed':
                this.handleThreadItem(event.item, 'completed');
                return;
            case 'error':
                this.emitEvent({ type: 'agent_message', message: event.message });
                return;
        }
    }

    async interruptTurn(): Promise<void> {
        this.pendingTurn?.controller.abort();
    }

    async abortTurnWithFallback(): Promise<{ hadActiveTurn: boolean; aborted: boolean }> {
        const pending = this.pendingTurn;
        if (!pending) {
            return { hadActiveTurn: false, aborted: false };
        }

        pending.controller.abort();
        try {
            await pending.promise;
        } catch {}

        return { hadActiveTurn: true, aborted: true };
    }
}

function serializeCodexConfigValue(value: unknown): CodexConfigValue | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        const entries = value
            .map((entry) => serializeCodexConfigValue(entry))
            .filter((entry): entry is CodexConfigValue => entry !== undefined);
        return entries;
    }
    if (typeof value === 'object') {
        const result: { [key: string]: CodexConfigValue } = {};
        for (const [key, entry] of Object.entries(value)) {
            const serialized = serializeCodexConfigValue(entry);
            if (serialized !== undefined) {
                result[key] = serialized;
            }
        }
        return result;
    }
    return undefined;
}
