/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { registerOpenClawHandlers, openClawTunnelManager } from '../modules/openclaw';
import { listClaudeSessionsFromIndex, getClaudeSessionPreview, findClaudeProjectId, getClaudeSessionUserMessages, saveClaudeSessionCacheStats } from '@/claude/utils/claudeSessionIndex';
import { forkAndTruncateSession, forkSession } from '@/claude/utils/claudeSessionFork';
import { readGeminiSessionLog, listGeminiSessions, getGeminiSessionPreview, saveGeminiSessionCacheStats } from '@/gemini/utils/sessionReader';
import { forkGeminiSession, forkAndTruncateGeminiSession } from '@/gemini/utils/sessionFork';
import { readCodexSessionUserMessages, listCodexSessions, getCodexSessionPreview, saveCodexSessionCacheStats } from '@/codex/utils/codexSessionReader';
import { forkCodexSession, forkAndTruncateCodexSession } from '@/codex/utils/codexSessionFork';
import { SessionCache, matchFields, type SessionCacheRuntimeStats } from '@/cache/SessionCache';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { execSync, execFileSync } from 'node:child_process';
import { readdirSync, rmdirSync } from 'node:fs';

function createSessionCacheStatsReporter(
    saveStats: (stats: SessionCacheRuntimeStats) => Promise<void>,
    label: string
): (stats: SessionCacheRuntimeStats) => void {
    let pendingStats: SessionCacheRuntimeStats | null = null;
    let flushPromise: Promise<void> | null = null;
    let flushTimer: NodeJS.Timeout | null = null;

    const flush = async (): Promise<void> => {
        if (flushPromise || !pendingStats) {
            return;
        }

        const stats = pendingStats;
        pendingStats = null;
        flushPromise = saveStats(stats).catch((error) => {
            logger.debug(`[API MACHINE] Failed to persist ${label} session cache stats`, error);
        }).then(() => {
            flushPromise = null;
        });

        await flushPromise;
        if (pendingStats) {
            await flush();
        }
    };

    const scheduleFlush = (): void => {
        if (flushTimer) {
            return;
        }

        flushTimer = setTimeout(() => {
            flushTimer = null;
            void flush();
        }, 100);
    };

    return (stats: SessionCacheRuntimeStats) => {
        pendingStats = stats;
        scheduleFlush();
    };
}

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
    orchestratorDispatch: (params: {
        executionId: string;
        runId: string;
        taskId: string;
        dispatchToken: string;
        provider: 'claude' | 'codex' | 'gemini';
        prompt: string;
        timeoutMs: number;
        workingDirectory?: string;
    }) => Promise<{
        accepted: boolean;
        duplicate?: boolean;
    }>;
    orchestratorCancel: (params: {
        executionId: string;
        runId: string;
        taskId: string;
        dispatchToken: string;
    }) => Promise<{
        accepted: boolean;
        notFound?: boolean;
    }>;
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;

    private claudeCache = new SessionCache({
        loader: listClaudeSessionsFromIndex,
        staleTTL: 30_000,
        matchFn: (s, q) => matchFields(q, [s.sessionId, s.title, s.projectId]),
        onStatsChanged: createSessionCacheStatsReporter(saveClaudeSessionCacheStats, 'claude'),
    });

    private geminiCache = new SessionCache({
        loader: listGeminiSessions,
        staleTTL: 30_000,
        matchFn: (s, q) => matchFields(q, [s.sessionId, s.title]),
        onStatsChanged: createSessionCacheStatsReporter(saveGeminiSessionCacheStats, 'gemini'),
    });

    private codexCache = new SessionCache({
        loader: listCodexSessions,
        staleTTL: 30_000,
        matchFn: (s, q) => matchFields(q, [s.sessionId, s.title]),
        onStatsChanged: createSessionCacheStatsReporter(saveCodexSessionCacheStats, 'codex'),
    });

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        registerCommonHandlers(this.rpcHandlerManager, homedir());
        registerOpenClawHandlers(this.rpcHandlerManager, {
            key: this.machine.encryptionKey
        });

        // Set up OpenClaw event forwarding
        openClawTunnelManager.setEventCallback((tunnelId, event, payload) => {
            this.broadcastOpenClawEvent(tunnelId, event, payload);
        });
    }

    /**
     * Broadcast an OpenClaw tunnel event to connected clients
     */
    private broadcastOpenClawEvent(tunnelId: string, event: string, payload: unknown): void {
        if (!this.socket?.connected) {
            return;
        }

        const eventData = {
            type: 'openclaw-tunnel-event',
            tunnelId,
            event,
            payload,
        };

        // Encrypt and send as RPC call to be forwarded to the mobile client
        const encryptedData = encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, eventData));
        const rpcMethod = `${this.machine.id}:openclaw-tunnel-event`;

        this.socket.emit('rpc-call', {
            method: rpcMethod,
            params: encryptedData,
        }, () => {
            // Callback required but result not needed
        });
    }

    setRPCHandlers({
        spawnSession,
        stopSession,
        requestShutdown,
        orchestratorDispatch,
        orchestratorCancel
    }: MachineRpcHandlers) {
        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, resumeSessionId, sessionTitle, skipForkSession, machineId, approvedNewDirectoryCreation, agent, token, environmentVariables, worktreeBasePath, worktreeBranchName, workspaceRepos, workspacePath, repoScripts, mcpServers } = params || {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, resumeSessionId, sessionTitle, skipForkSession, machineId, approvedNewDirectoryCreation, agent, token, environmentVariables, worktreeBasePath, worktreeBranchName, workspaceRepos, workspacePath, repoScripts, mcpServers });

            switch (result.type) {
                case 'success':
                    this.claudeCache.invalidate();
                    this.geminiCache.invalidate();
                    this.codexCache.invalidate();
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        // Register archive-workspace handler
        this.rpcHandlerManager.registerHandler('archive-workspace', async (params: any) => {
            const { workspacePath, repos } = params || {};
            if (!workspacePath || !repos || !Array.isArray(repos)) {
                return { success: false, error: 'Missing workspacePath or repos' };
            }

            const results: Array<{ repo: string; success: boolean; error?: string }> = [];

            for (const repo of repos) {
                const { worktreePath, basePath, branchName, archiveScript, deleteBranch } = repo;
                try {
                    // Run archive script if configured
                    if (archiveScript) {
                        logger.info(`[DAEMON] Running archive script in ${worktreePath}...`);
                        execSync(archiveScript, { cwd: worktreePath, stdio: 'pipe', timeout: 300000 });
                        logger.info(`[DAEMON] Archive script completed for ${worktreePath}`);
                    }

                    // Remove worktree (use execFileSync to avoid shell injection)
                    try {
                        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
                            cwd: basePath, stdio: 'pipe', timeout: 30000
                        });
                    } catch (err: any) {
                        logger.warn(`[DAEMON] git worktree remove failed: ${err.message}`);
                    }

                    // Delete branch if requested (use execFileSync to avoid shell injection)
                    if (deleteBranch && branchName) {
                        try {
                            execFileSync('git', ['branch', '-D', branchName], {
                                cwd: basePath, stdio: 'pipe', timeout: 10000
                            });
                        } catch (err: any) {
                            logger.warn(`[DAEMON] git branch -D failed: ${err.message}`);
                        }
                    }

                    results.push({ repo: worktreePath, success: true });
                } catch (err: any) {
                    logger.warn(`[DAEMON] Archive failed for ${worktreePath}: ${err.message}`);
                    results.push({ repo: worktreePath, success: false, error: err.message });
                }
            }

            // Clean up workspace directory if empty
            try {
                const entries = readdirSync(workspacePath);
                if (entries.length === 0) {
                    rmdirSync(workspacePath);
                    logger.info(`[DAEMON] Removed empty workspace directory: ${workspacePath}`);
                }
            } catch {
                // Ignore — workspace dir might not exist or not be empty
            }

            return { success: results.every(r => r.success), results };
        });

        // Register stop session handler
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            this.claudeCache.invalidate();
            this.geminiCache.invalidate();
            this.codexCache.invalidate();

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });

        // Register orchestrator dispatch handler
        this.rpcHandlerManager.registerHandler('orchestrator-dispatch', async (params: any) => {
            const { executionId, runId, taskId, dispatchToken, provider, prompt, timeoutMs, workingDirectory } = params || {};

            if (!executionId || typeof executionId !== 'string') {
                throw new Error('executionId is required');
            }
            if (!runId || typeof runId !== 'string') {
                throw new Error('runId is required');
            }
            if (!taskId || typeof taskId !== 'string') {
                throw new Error('taskId is required');
            }
            if (!dispatchToken || typeof dispatchToken !== 'string') {
                throw new Error('dispatchToken is required');
            }
            if (!provider || typeof provider !== 'string') {
                throw new Error('provider is required');
            }
            if (provider !== 'claude' && provider !== 'codex' && provider !== 'gemini') {
                throw new Error(`Unsupported provider: ${provider}`);
            }
            if (typeof prompt !== 'string' || prompt.trim().length === 0) {
                throw new Error('prompt is required');
            }
            if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                throw new Error('timeoutMs must be a positive number');
            }
            if (workingDirectory !== undefined && (typeof workingDirectory !== 'string' || workingDirectory.length > 512)) {
                throw new Error('workingDirectory must be a string with max length 512');
            }

            return orchestratorDispatch({
                executionId,
                runId,
                taskId,
                dispatchToken,
                provider,
                prompt,
                timeoutMs: Math.floor(timeoutMs),
                workingDirectory,
            });
        });

        // Register orchestrator cancel handler
        this.rpcHandlerManager.registerHandler('orchestrator-cancel', async (params: any) => {
            const { executionId, runId, taskId, dispatchToken } = params || {};

            if (!executionId || typeof executionId !== 'string') {
                throw new Error('executionId is required');
            }
            if (!runId || typeof runId !== 'string') {
                throw new Error('runId is required');
            }
            if (!taskId || typeof taskId !== 'string') {
                throw new Error('taskId is required');
            }
            if (!dispatchToken || typeof dispatchToken !== 'string') {
                throw new Error('dispatchToken is required');
            }

            return orchestratorCancel({
                executionId,
                runId,
                taskId,
                dispatchToken,
            });
        });

        // List Claude sessions from local index
        this.rpcHandlerManager.registerHandler('claude-list-sessions', async (params: any) => {
            const offset = typeof params?.offset === 'number' && params.offset >= 0 ? Math.floor(params.offset) : 0;
            const limit = typeof params?.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 50;
            const query = typeof params?.query === 'string' ? params.query : undefined;
            const waitForRefresh = params?.waitForRefresh === true;
            return this.claudeCache.list({ offset, limit, query, waitForRefresh });
        });

        // Get preview messages from a Claude session
        this.rpcHandlerManager.registerHandler('claude-session-preview', async (params: any) => {
            const { projectId, sessionId, limit = 10 } = params || {};

            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }

            const messageLimit = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
            const messages = await getClaudeSessionPreview(projectId, sessionId, messageLimit);
            return { messages };
        });

        // Get user messages with UUIDs for the duplicate/fork feature
        this.rpcHandlerManager.registerHandler('claude-session-user-messages', async (params: any) => {
            const { sessionId, limit = 50 } = params || {};

            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }

            // Find the project ID for this session
            const projectId = await findClaudeProjectId(sessionId);
            if (!projectId) {
                throw new Error('Session not found');
            }

            const messageLimit = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 100) : 50;
            const messages = await getClaudeSessionUserMessages(projectId, sessionId, messageLimit);
            return { messages, projectId };
        });

        // Fork and truncate a Claude session for the duplicate feature
        this.rpcHandlerManager.registerHandler('claude-duplicate-session', async (params: any) => {
            const { sessionId, truncateBeforeUuid } = params || {};

            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }
            if (!truncateBeforeUuid || typeof truncateBeforeUuid !== 'string') {
                throw new Error('truncateBeforeUuid is required');
            }

            // Find the project ID for this session
            const projectId = await findClaudeProjectId(sessionId);
            if (!projectId) {
                throw new Error('Session not found');
            }

            const result = await forkAndTruncateSession(projectId, sessionId, truncateBeforeUuid);
            return result;
        });

        // Fork a Claude session without truncation (used by resume flows)
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }

            // Find the project ID for this session
            const projectId = await findClaudeProjectId(sessionId);
            if (!projectId) {
                throw new Error('Session not found');
            }

            const result = await forkSession(projectId, sessionId);
            return result;
        });

        // --- Gemini session handlers ---

        // Get user messages from a Gemini session JSONL
        this.rpcHandlerManager.registerHandler('gemini-session-user-messages', async (params: any) => {
            const { sessionId, limit = 50 } = params || {};
            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }
            const messageLimit = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 100) : 50;
            const lines = await readGeminiSessionLog(sessionId);
            let userIndex = 0;
            const messages = lines
                .filter(l => l.type === 'user')
                .map(l => ({
                    uuid: l.uuid,
                    content: l.message.length > 500 ? l.message.substring(0, 500) + '...' : l.message,
                    timestamp: new Date(l.timestamp).toISOString(),
                    index: userIndex++,
                }))
                .slice(-messageLimit);
            return { messages };
        });

        // Fork and truncate a Gemini session for duplicate
        this.rpcHandlerManager.registerHandler('gemini-duplicate-session', async (params: any) => {
            const { sessionId, truncateBeforeUuid } = params || {};
            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }
            if (!truncateBeforeUuid || typeof truncateBeforeUuid !== 'string') {
                throw new Error('truncateBeforeUuid is required');
            }
            return await forkAndTruncateGeminiSession(sessionId, truncateBeforeUuid);
        });

        // Fork a Gemini session without truncation (resume)
        this.rpcHandlerManager.registerHandler('gemini-fork-session', async (params: any) => {
            const { sessionId } = params || {};
            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }
            return await forkGeminiSession(sessionId);
        });

        // --- Codex session handlers ---

        // Get user messages from a Codex session JSONL
        this.rpcHandlerManager.registerHandler('codex-session-user-messages', async (params: any) => {
            const { codexSessionId, limit = 50 } = params || {};
            if (!codexSessionId || typeof codexSessionId !== 'string') {
                throw new Error('codexSessionId is required');
            }
            const messageLimit = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 100) : 50;
            const messages = await readCodexSessionUserMessages(codexSessionId, messageLimit);
            return { messages };
        });

        // Fork and truncate a Codex session for duplicate
        this.rpcHandlerManager.registerHandler('codex-duplicate-session', async (params: any) => {
            const { codexSessionId, truncateBeforeUuid } = params || {};
            if (!codexSessionId || typeof codexSessionId !== 'string') {
                throw new Error('codexSessionId is required');
            }
            if (!truncateBeforeUuid || typeof truncateBeforeUuid !== 'string') {
                throw new Error('truncateBeforeUuid is required');
            }
            return await forkAndTruncateCodexSession(codexSessionId, truncateBeforeUuid);
        });

        // Fork a Codex session without truncation (resume)
        this.rpcHandlerManager.registerHandler('codex-fork-session', async (params: any) => {
            const { codexSessionId } = params || {};
            if (!codexSessionId || typeof codexSessionId !== 'string') {
                throw new Error('codexSessionId is required');
            }
            return await forkCodexSession(codexSessionId);
        });

        // --- Gemini session listing & preview ---

        this.rpcHandlerManager.registerHandler('gemini-list-sessions', async (params: any) => {
            const offset = typeof params?.offset === 'number' && params.offset >= 0 ? Math.floor(params.offset) : 0;
            const limit = typeof params?.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 50;
            const query = typeof params?.query === 'string' ? params.query : undefined;
            const waitForRefresh = params?.waitForRefresh === true;
            return this.geminiCache.list({ offset, limit, query, waitForRefresh });
        });

        this.rpcHandlerManager.registerHandler('gemini-session-preview', async (params: any) => {
            const { sessionId, limit = 10 } = params || {};
            if (!sessionId || typeof sessionId !== 'string') {
                throw new Error('sessionId is required');
            }
            const messageLimit = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
            const messages = await getGeminiSessionPreview(sessionId, messageLimit);
            return { messages };
        });

        // --- Codex session listing & preview ---

        this.rpcHandlerManager.registerHandler('codex-list-sessions', async (params: any) => {
            const offset = typeof params?.offset === 'number' && params.offset >= 0 ? Math.floor(params.offset) : 0;
            const limit = typeof params?.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 50;
            const query = typeof params?.query === 'string' ? params.query : undefined;
            const waitForRefresh = params?.waitForRefresh === true;
            return this.codexCache.list({ offset, limit, query, waitForRefresh });
        });

        this.rpcHandlerManager.registerHandler('codex-session-preview', async (params: any) => {
            const { codexSessionId, limit = 10 } = params || {};
            if (!codexSessionId || typeof codexSessionId !== 'string') {
                throw new Error('codexSessionId is required');
            }
            const messageLimit = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
            const messages = await getCodexSessionPreview(codexSessionId, messageLimit);
            return { messages };
        });
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            // Update daemon state to running
            // We need to override previous state because the daemon (this process)
            // has restarted with new PID & port
            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));


            // Register all handlers
            this.rpcHandlerManager.onSocketConnect(this.socket);

            // Start keep-alive
            this.startKeepAlive();
        });

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from server');
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        openClawTunnelManager.closeAll();
        this.stopKeepAlive();
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}
