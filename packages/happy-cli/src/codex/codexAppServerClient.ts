/**
 * Codex App Server Client — drives Codex via the v2 JSON-RPC protocol
 * (`codex app-server`), replacing the legacy MCP-based CodexMcpClient.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { execSync } from 'child_process';
import type {
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    InterruptConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import packageJson from '../../package.json';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
};

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch';
    callId: string;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
}) => Promise<ReviewDecision>;

/**
 * Check that `codex app-server` is available.
 */
function isAppServerAvailable(): boolean {
    try {
        const version = execSync('codex --version', { encoding: 'utf8' }).trim();
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

export class CodexAppServerClient {
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private connected = false;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;

    // Turn completion tracking — resolved when task_complete or turn_aborted arrives
    private turnCompleteResolve: ((aborted: boolean) => void) | null = null;

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;

    constructor(sandboxConfig?: SandboxConfig) {
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

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;

        if (!isAppServerAvailable()) {
            throw new Error(
                'Codex CLI not found or too old for app-server.\n\n' +
                'To install codex:\n  npm install -g @openai/codex\n\n' +
                'Alternatively, use Claude:\n  happy claude',
            );
        }

        let command = 'codex';
        let args = ['app-server', '--listen', 'stdio://'];
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
                const wrapped = await wrapForMcpTransport('codex', ['app-server', '--listen', 'stdio://']);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                logger.warn('[CodexAppServer] Failed to initialize sandbox; continuing without.', error);
                this.sandboxCleanup = null;
            }
        }

        // Build env — same filtering as the old MCP client
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') env[key] = value;
        }
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

        this.process = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });

        this.process.on('error', (err) => {
            logger.debug('[CodexAppServer] Process error:', err);
        });

        this.process.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            this.connected = false;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
                this.pending.delete(id);
            }
            // Resolve pending turn completion (treat as abort)
            if (this.turnCompleteResolve) {
                this.turnCompleteResolve(true);
                this.turnCompleteResolve = null;
            }
        });

        // Pipe stderr for debug logging
        this.process.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) logger.debug(`[CodexAppServer:stderr] ${text}`);
        });

        // Parse newline-delimited JSON from stdout
        this.readline = createInterface({ input: this.process.stdout! });
        this.readline.on('line', (line) => this.handleLine(line));

        // Perform initialize handshake
        const initParams: InitializeParams = {
            clientInfo: {
                name: 'happy-codex',
                title: 'Happy Codex Client',
                version: packageJson.version,
            },
            capabilities: null,
        };
        await this.request('initialize', initParams);
        this.notify('initialized');
        this.connected = true;
        logger.debug('[CodexAppServer] Connected and initialized');
    }

    async disconnect(): Promise<void> {
        if (!this.connected && !this.process) return;

        const pid = this.process?.pid;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'}`);

        this.readline?.close();
        this.readline = null;

        try {
            this.process?.stdin?.end();
            this.process?.kill('SIGTERM');
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

        this.process = null;
        this.connected = false;
        this._threadId = null;
        this._turnId = null;

        // Resolve pending turn completion (treat as abort)
        if (this.turnCompleteResolve) {
            this.turnCompleteResolve(true);
            this.turnCompleteResolve = null;
        }

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        logger.debug('[CodexAppServer] Disconnected');
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: opts.mcpServers ? { mcp_servers: opts.mcpServers } : null,
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        this._threadId = result.thread.id;
        logger.debug('[CodexAppServer] Thread started:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    // ─── Turn management ────────────────────────────────────────

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
    }): Promise<void> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        const input: InputItem[] = [
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
        await this.request('turn/start', params);
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
    }): Promise<{ aborted: boolean }> {
        const timeoutMs = opts?.turnTimeoutMs ?? CodexAppServerClient.TURN_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const completion = new Promise<boolean>((resolve) => {
            this.turnCompleteResolve = resolve;

            timer = setTimeout(() => {
                if (this.turnCompleteResolve) {
                    logger.warn(`[CodexAppServer] Turn timed out after ${timeoutMs}ms — treating as abort`);
                    this.turnCompleteResolve(true);
                    this.turnCompleteResolve = null;
                }
            }, timeoutMs);
        });

        try {
            await this.sendTurn(prompt, opts);
        } catch (err) {
            if (timer) clearTimeout(timer);
            this.turnCompleteResolve = null;
            throw err;
        }

        const aborted = await completion;
        if (timer) clearTimeout(timer);
        return { aborted };
    }

    async interruptTurn(): Promise<void> {
        if (!this._threadId) return;
        const params: InterruptConversationParams = {
            threadId: this._threadId,
        };
        try {
            await this.request('turn/interrupt', params);
        } catch (err) {
            // Ignore if no turn is active
            logger.debug('[CodexAppServer] interruptTurn error (may be expected):', err);
        }
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this._threadId !== null;
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Cannot send ${method}: stdin not writable`));
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
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            const line = JSON.stringify(msg) + '\n';
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            this.process.stdin.write(line);
        });
    }

    private notify(method: string, params?: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private respond(id: number, result: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private handleLine(line: string): void {
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
    private mapDecisionToWire(decision: ReviewDecision): string | Record<string, unknown> {
        if (typeof decision === 'string') {
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
        return 'decline';
    }

    private async handleServerRequest(id: number, method: string, params: any): Promise<void> {
        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const decision = await this.handleApproval({
                type: 'exec',
                callId: params.itemId ?? String(id),
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision) });
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const decision = await this.handleApproval({
                type: 'patch',
                callId: params.itemId ?? String(id),
                fileChanges: params.fileChanges,
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision) });
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
            const msg = params?.msg;
            if (msg) {
                // Extract turn_id from task_started events
                if (msg.type === 'task_started' && msg.turn_id) {
                    this._turnId = msg.turn_id;
                }
                // Fire event handler first (so consumer processes the event)
                this.eventHandler?.(msg);
                // Then resolve turn completion promise
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    if (this.turnCompleteResolve) {
                        this.turnCompleteResolve(msg.type === 'turn_aborted');
                        this.turnCompleteResolve = null;
                    }
                }
            }
            return;
        }

        // v2 lifecycle notifications — log but don't process (our event handler
        // already gets task_started/task_complete via codex/event)
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${method}`);
            return;
        }

        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
