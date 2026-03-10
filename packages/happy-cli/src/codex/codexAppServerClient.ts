import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { CodexPermissionHandler } from './utils/permissionHandler';
import type { CodexSessionConfig, CodexToolResponse } from './types';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000;

function createAbortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function mapPermissionResultToApprovalDecision(result: any, kind: 'command' | 'file'): any {
    if (result?.decision === 'approved_for_session') {
        return 'acceptForSession';
    }
    if (result?.decision === 'approved_execpolicy_amendment' && kind === 'command' && result.execPolicyAmendment?.command?.length) {
        return {
            acceptWithExecpolicyAmendment: {
                execpolicy_amendment: result.execPolicyAmendment.command
            }
        };
    }
    if (result?.decision === 'abort') {
        return 'cancel';
    }
    if (result?.decision === 'approved' || result?.decision === 'approved_execpolicy_amendment') {
        return 'accept';
    }
    return 'decline';
}

function mapSandboxModeToPolicy(mode: CodexSessionConfig['sandbox']) {
    switch (mode) {
        case 'read-only':
            return {
                type: 'readOnly',
                access: { type: 'fullAccess' },
                networkAccess: false
            };
        case 'danger-full-access':
            return {
                type: 'dangerFullAccess'
            };
        case 'workspace-write':
        default:
            return {
                type: 'workspaceWrite',
                writableRoots: [],
                readOnlyAccess: { type: 'fullAccess' },
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false
            };
    }
}

function stringifyError(error: unknown): unknown {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    }
    return error;
}

function ensureCodexCliAvailable(): void {
    try {
        execSync('codex --version', { stdio: 'ignore' });
    } catch {
        throw new Error(
            'Codex CLI not found or not executable.\n' +
            '\n' +
            'To install codex:\n' +
            '  npm install -g @openai/codex\n' +
            '\n' +
            'Alternatively, use Claude:\n' +
            '  happy claude'
        );
    }
}

type PendingRequest = {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

type PendingTurn = {
    resolve: (value: CodexToolResponse & { structuredContent?: any }) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

export class CodexAppServerClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private connected = false;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private requestCounter = 0;
    private stdoutBuffer = '';
    private pendingRequests = new Map<string, PendingRequest>();
    private pendingTurns = new Map<string, PendingTurn>();
    private lastAgentMessages = new Map<string, string>();
    private resumed = false;
    private threadConfig: Partial<CodexSessionConfig> = {};

    public sandboxEnabled = false;

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    seedSessionIdentifiers(sessionId: string | null, conversationId: string | null): void {
        const normalizedSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
        const normalizedConversationId =
            typeof conversationId === 'string' && conversationId.length > 0 ? conversationId : normalizedSessionId;
        this.sessionId = normalizedSessionId;
        this.conversationId = normalizedConversationId;
        this.resumed = false;
        logger.debug('[CodexAppServer] Session identifiers seeded', {
            sessionId: this.sessionId,
            conversationId: this.conversationId
        });
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    hasActiveSession(): boolean {
        return this.sessionId !== null;
    }

    clearSession(): void {
        const previousSessionId = this.sessionId;
        this.sessionId = null;
        this.conversationId = null;
        this.resumed = false;
        this.threadConfig = {};
        logger.debug('[CodexAppServer] Session cleared, previous sessionId:', previousSessionId);
    }

    storeSessionForResume(): string | null {
        logger.debug('[CodexAppServer] Storing session for potential resume:', this.sessionId);
        return this.sessionId;
    }

    async resumeSavedThread(
        config?: Partial<CodexSessionConfig>,
        options?: { timeout?: number; signal?: AbortSignal }
    ): Promise<void> {
        if (!this.connected) {
            await this.connect();
        }
        await this.ensureThreadResumed(config, options);
    }

    async forceCloseSession(): Promise<void> {
        logger.debug('[CodexAppServer] Force closing session');
        try {
            await this.disconnect();
        } finally {
            this.clearSession();
        }
        logger.debug('[CodexAppServer] Session force-closed');
    }

    async disconnect(): Promise<void> {
        if (!this.child) {
            this.connected = false;
            return;
        }

        const child = this.child;
        this.child = null;
        this.connected = false;

        try {
            child.kill('SIGTERM');
        } catch {
        }

        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), 500);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        ensureCodexCliAvailable();
        logger.debug('[CodexAppServer] Connecting using command: codex app-server --listen stdio://');

        const transportEnv = Object.keys(process.env).reduce((acc, key) => {
            const value = process.env[key];
            if (typeof value === 'string') {
                acc[key] = value;
            }
            return acc;
        }, {} as Record<string, string>);

        this.child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
            env: transportEnv,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.child.stdout.on('data', (chunk) => {
            this.handleStdoutChunk(chunk.toString('utf8'));
        });

        this.child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8').trim();
            if (text) {
                logger.debug('[CodexAppServer][stderr]', text);
            }
        });

        this.child.on('exit', (code, signal) => {
            logger.debug('[CodexAppServer] Process exited', { code, signal });
            const error = new Error(`Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
            for (const { reject, timer } of this.pendingRequests.values()) {
                clearTimeout(timer);
                reject(error);
            }
            this.pendingRequests.clear();
            for (const { reject, timer } of this.pendingTurns.values()) {
                clearTimeout(timer);
                reject(error);
            }
            this.pendingTurns.clear();
            this.connected = false;
            this.child = null;
        });

        this.child.on('error', (error) => {
            logger.debug('[CodexAppServer] Process error', stringifyError(error));
        });

        await this.request('initialize', {
            clientInfo: {
                name: 'happy-codex-app-server-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        this.connected = true;
        logger.debug('[CodexAppServer] Connected');
    }

    private handleStdoutChunk(chunk: string): void {
        this.stdoutBuffer += chunk;

        while (true) {
            const newlineIndex = this.stdoutBuffer.indexOf('\n');
            if (newlineIndex === -1) {
                break;
            }
            const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            if (!line) {
                continue;
            }

            try {
                const message = JSON.parse(line);
                this.dispatchMessage(message);
            } catch (error) {
                logger.debug('[CodexAppServer] Failed to parse stdout line', { line, error: stringifyError(error) });
            }
        }
    }

    private dispatchMessage(message: any): void {
        if (message && typeof message === 'object' && 'id' in message && ('result' in message || 'error' in message)) {
            const pending = this.pendingRequests.get(message.id);
            if (!pending) {
                return;
            }
            clearTimeout(pending.timer);
            this.pendingRequests.delete(message.id);
            if ('error' in message) {
                pending.reject(new Error(message.error?.message || 'App server request failed'));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (message && typeof message === 'object' && 'id' in message && 'method' in message) {
            void this.handleServerRequest(message);
            return;
        }

        if (message && typeof message === 'object' && 'method' in message) {
            this.handleNotification(message);
        }
    }

    private send(message: unknown): void {
        if (!this.child?.stdin) {
            throw new Error('Codex app-server stdin is not available');
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private request(method: string, params: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<any> {
        const id = `${method}-${++this.requestCounter}-${randomUUID()}`;
        const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT;

        if (options?.signal?.aborted) {
            return Promise.reject(createAbortError());
        }

        return new Promise((resolve, reject) => {
            let settled = false;

            const cleanupAbort = () => {
                options?.signal?.removeEventListener('abort', onAbort);
            };

            const settleReject = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanupAbort();
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                reject(error);
            };

            const settleResolve = (value: unknown) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanupAbort();
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                resolve(value);
            };

            const onAbort = () => {
                settleReject(createAbortError());
            };

            const timer = setTimeout(() => {
                settleReject(new Error(`Codex app-server request timed out: ${method}`));
            }, timeoutMs);

            if (options?.signal) {
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            this.pendingRequests.set(id, { resolve: settleResolve, reject: settleReject, timer });
            this.send({
                id,
                method,
                params
            });
        });
    }

    private async handleServerRequest(message: any): Promise<void> {
        try {
            let result: unknown;
            switch (message.method) {
                case 'item/commandExecution/requestApproval':
                    result = await this.handleCommandApproval(message.params);
                    break;
                case 'item/fileChange/requestApproval':
                    result = await this.handleFileChangeApproval(message.params);
                    break;
                case 'item/tool/call':
                    result = {
                        success: false,
                        contentItems: [
                            {
                                type: 'inputText',
                                text: `Dynamic tool calls are not supported by Happy's app-server restore path: ${message.params?.tool || 'unknown'}`
                            }
                        ]
                    };
                    break;
                case 'item/tool/requestUserInput':
                    result = { answers: {} };
                    break;
                case 'mcpServer/elicitation/request':
                    result = { action: 'decline' };
                    break;
                default:
                    throw new Error(`Unsupported app-server request method: ${message.method}`);
            }

            this.send({
                id: message.id,
                result
            });
        } catch (error) {
            logger.debug('[CodexAppServer] Error handling server request', {
                method: message?.method,
                error: stringifyError(error)
            });
            this.send({
                id: message.id,
                error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : 'Unknown app-server request error'
                }
            });
        }
    }

    private async handleCommandApproval(params: any): Promise<{ decision: any }> {
        if (!this.permissionHandler) {
            return { decision: 'decline' };
        }

        const permissionId = String(params.approvalId ?? params.itemId ?? randomUUID());
        const command = Array.isArray(params.command)
            ? params.command.join(' ')
            : typeof params.command === 'string'
                ? params.command
                : '';
        const result = await this.permissionHandler.handleToolCall(permissionId, 'CodexBash', {
            command,
            cwd: params.cwd,
            reason: params.reason,
            commandActions: params.commandActions,
            proposedExecpolicyAmendment: params.proposedExecpolicyAmendment
        });

        return {
            decision: mapPermissionResultToApprovalDecision(result, 'command')
        };
    }

    private async handleFileChangeApproval(params: any): Promise<{ decision: any }> {
        if (!this.permissionHandler) {
            return { decision: 'decline' };
        }
        const permissionId = String(params.itemId ?? randomUUID());
        const result = await this.permissionHandler.handleToolCall(permissionId, 'CodexPatch', params);
        return {
            decision: mapPermissionResultToApprovalDecision(result, 'file')
        };
    }

    private handleNotification(notification: any): void {
        if (notification.method === 'turn/completed') {
            this.resolveTurn(notification.params?.turn?.id || notification.params?.turnId);
            return;
        }

        if (!notification.method?.startsWith('codex/event/')) {
            return;
        }

        const params = notification.params || {};
        const msg = params.msg;
        if (!msg || typeof msg !== 'object') {
            return;
        }

        const threadId = typeof msg.thread_id === 'string' && msg.thread_id.length > 0 ? msg.thread_id : null;
        const conversationId =
            typeof params.conversationId === 'string' && params.conversationId.length > 0
                ? params.conversationId
                : threadId;

        if (threadId) {
            this.sessionId = threadId;
        }
        if (conversationId) {
            this.conversationId = conversationId;
        }

        if (msg.type === 'agent_message') {
            const turnId = typeof params.id === 'string' && params.id.length > 0 ? params.id : msg.turn_id;
            if (turnId && typeof msg.message === 'string') {
                this.lastAgentMessages.set(turnId, msg.message);
            }
        } else if (msg.type === 'task_complete') {
            const turnId = typeof msg.turn_id === 'string' && msg.turn_id.length > 0 ? msg.turn_id : params.id;
            this.resolveTurn(turnId, msg.last_agent_message);
        }

        this.handler?.(msg);
    }

    private resolveTurn(turnId: string | null | undefined, finalMessage?: string): void {
        if (!turnId) {
            return;
        }
        const pending = this.pendingTurns.get(turnId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timer);
        this.pendingTurns.delete(turnId);
        const message = typeof finalMessage === 'string' && finalMessage.length > 0
            ? finalMessage
            : this.lastAgentMessages.get(turnId) || '';
        this.lastAgentMessages.delete(turnId);

        pending.resolve({
            content: message ? [{ type: 'text', text: message }] : [],
            structuredContent: {
                threadId: this.sessionId,
                content: message
            }
        });
    }

    private buildThreadParams(config?: Partial<CodexSessionConfig>): Record<string, any> {
        const params: Record<string, any> = {};
        if (config?.cwd) {
            params.cwd = config.cwd;
        }
        if (config?.config) {
            params.config = config.config;
        }
        if (config?.['approval-policy']) {
            params.approvalPolicy = config['approval-policy'];
        }
        if (config?.sandbox) {
            params.sandbox = config.sandbox;
        }
        if (config?.model) {
            params.model = config.model;
        }
        return params;
    }

    private buildTurnParams(prompt: string, config?: Partial<CodexSessionConfig>): Record<string, any> {
        const params: Record<string, any> = {
            threadId: this.sessionId,
            input: [
                {
                    type: 'text',
                    text: prompt
                }
            ]
        };
        if (config?.cwd) {
            params.cwd = config.cwd;
        }
        if (config?.['approval-policy']) {
            params.approvalPolicy = config['approval-policy'];
        }
        if (config?.sandbox) {
            params.sandboxPolicy = mapSandboxModeToPolicy(config.sandbox);
        }
        if (config?.model) {
            params.model = config.model;
        }
        return params;
    }

    private async ensureThreadResumed(config?: Partial<CodexSessionConfig>, options?: { timeout?: number; signal?: AbortSignal }): Promise<void> {
        if (this.resumed) {
            return;
        }
        if (!this.sessionId) {
            throw new Error('No saved Codex thread id to resume');
        }

        const response = await this.request('thread/resume', {
            threadId: this.sessionId,
            ...this.buildThreadParams(config)
        }, options);
        const threadId = response?.thread?.id;
        if (typeof threadId === 'string' && threadId.length > 0) {
            this.sessionId = threadId;
            this.conversationId = threadId;
        }
        this.resumed = true;
        this.threadConfig = { ...this.threadConfig, ...config };
        logger.debug('[CodexAppServer] Resumed thread', { threadId: this.sessionId });
    }

    private async waitForTurn(turnId: string | null | undefined, options?: { timeout?: number; signal?: AbortSignal }): Promise<CodexToolResponse & { structuredContent?: any }> {
        if (!turnId) {
            return {
                content: [],
                structuredContent: {
                    threadId: this.sessionId,
                    content: ''
                }
            };
        }

        if (options?.signal?.aborted) {
            void this.interruptTurn(turnId);
            throw createAbortError();
        }

        return new Promise((resolve, reject) => {
            let settled = false;

            const cleanupAbort = () => {
                options?.signal?.removeEventListener('abort', onAbort);
            };

            const settleReject = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanupAbort();
                clearTimeout(timer);
                this.pendingTurns.delete(turnId);
                reject(error);
            };

            const settleResolve = (value: CodexToolResponse & { structuredContent?: any }) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanupAbort();
                clearTimeout(timer);
                this.pendingTurns.delete(turnId);
                resolve(value);
            };

            const onAbort = () => {
                void this.interruptTurn(turnId);
                settleReject(createAbortError());
            };

            const timer = setTimeout(() => {
                settleReject(new Error(`Codex app-server turn timed out: ${turnId}`));
            }, options?.timeout ?? DEFAULT_TIMEOUT);

            if (options?.signal) {
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            this.pendingTurns.set(turnId, { resolve: settleResolve, reject: settleReject, timer });
        });
    }

    private async interruptTurn(turnId: string): Promise<void> {
        if (!this.sessionId || !turnId) {
            return;
        }
        try {
            await this.request('turn/interrupt', {
                threadId: this.sessionId,
                turnId
            }, { timeout: 5000 });
            logger.debug('[CodexAppServer] Interrupted turn', { threadId: this.sessionId, turnId });
        } catch (error) {
            logger.debug('[CodexAppServer] Failed to interrupt turn', {
                threadId: this.sessionId,
                turnId,
                error: stringifyError(error)
            });
        }
    }

    private async runTurn(prompt: string, config?: Partial<CodexSessionConfig>, options?: { timeout?: number; signal?: AbortSignal }): Promise<CodexToolResponse & { structuredContent?: any }> {
        const response = await this.request('turn/start', this.buildTurnParams(prompt, config), options);
        const turnId = response?.turn?.id;
        return this.waitForTurn(turnId, options);
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) {
            await this.connect();
        }

        const response = await this.request('thread/start', this.buildThreadParams(config), options);
        const threadId = response?.thread?.id;
        if (!threadId) {
            throw new Error('Codex app-server did not return a thread id');
        }

        this.sessionId = threadId;
        this.conversationId = threadId;
        this.resumed = true;
        this.threadConfig = { ...config };
        logger.debug('[CodexAppServer] Started thread', { threadId });
        return this.runTurn(config.prompt, config, options);
    }

    async continueSession(
        prompt: string,
        options?: { signal?: AbortSignal; happyConfig?: Partial<CodexSessionConfig> }
    ): Promise<CodexToolResponse> {
        if (!this.connected) {
            await this.connect();
        }

        const config = options?.happyConfig || this.threadConfig;
        await this.ensureThreadResumed(config, options);
        this.threadConfig = { ...this.threadConfig, ...config };
        return this.runTurn(prompt, config, options);
    }
}
