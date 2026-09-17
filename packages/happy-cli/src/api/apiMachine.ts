/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { join } from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';
import { withCodexAccountThread } from '@/codex/codexAccountThread';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { createProcessRunner, resolveExecutable } from '@/environment/processRunner';
import { createGitHubCliAdapter } from '@/environment/githubCliAdapter';
import { createPawsCliAdapter } from '@/environment/pawsCliAdapter';
import { createEgoBrowserAdapter } from '@/environment/egoBrowserAdapter';
import { createWranglerAdapter } from '@/environment/wranglerAdapter';
import { createCloudflaredAdapter } from '@/environment/cloudflaredAdapter';
import { createEnvironmentService } from '@/environment/environmentService';
import { registerEnvironmentHandlers } from '@/environment/registerEnvironmentHandlers';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import { shouldReconnect } from '@/utils/lidState';
import { getProjectPath } from '@/claude/utils/path';
import {
    forkSession as claudeForkSession,
    forkAndTruncateSession as claudeForkAndTruncateSession,
    listClaudeRewindPoints,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from '@/claude/utils/claudeSessionFork';
import { CodexAppServerClient, resolveCodexAppServerConnection } from '@/codex/codexAppServerClient';
import { createCodexAttachCandidateService, listCodexThreadsFromStateDb } from '@/codex/codexAttachCandidates';
import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    listCodexRewindPoints,
} from '@/codex/codexThreadFork';
import { isTerminalCodexTurn } from '@/codex/utils/sessionProtocolMapper';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTUP_TRACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TracedSpawnSessionOptions = SpawnSessionOptions & { traceId?: string };

function traceIdFromParams(value: unknown): string | undefined {
    return typeof value === 'string' && STARTUP_TRACE_ID_RE.test(value) ? value : undefined;
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
    spawnSession: (options: TracedSpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string, options?: { model?: string; permissionMode?: string; effort?: string | null; codexSessionGrant?: string }) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
    refreshCodexUsage?: () => Promise<void>;
    refreshCodexAccountQuota?: (grant: string) => Promise<{ type: 'success'; accepted: boolean } | { type: 'error'; errorMessage: string }>;
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

async function withSharedCodexAppServerClient<T>(handler: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const connection = resolveCodexAppServerConnection({
        ...process.env,
        HAPPY_CODEX_APP_SERVER_MODE: 'shared',
        HAPPY_CODEX_APPROVAL_AUTHORITY: 'desktop',
    });
    const client = new CodexAppServerClient(undefined, connection);
    await client.connect();
    try {
        return await handler(client);
    } finally {
        await client.disconnect();
    }
}

async function deleteFailedCodexTakeoverFork(threadId: string, sourceSessionId: string): Promise<void> {
    try {
        await withCodexAccountThread({ sourceSessionId, codexThreadId: threadId }, (client) => client.deleteThread({ threadId }));
    } catch (error) {
        logger.debug('[API MACHINE] Failed to delete unused Codex takeover fork', error);
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private resumeSessionHandler: ((sessionId: string, options?: { model?: string; permissionMode?: string; effort?: string | null; codexSessionGrant?: string }) => Promise<SpawnSessionResult>) | null = null;
    private reconnectInterval: NodeJS.Timeout | null = null;
    private readonly codexAttachCandidates = createCodexAttachCandidateService({
        statePath: join(configuration.happyHomeDir, 'codex-attach-candidates.json'),
        listThreads: async () => listCodexThreadsFromStateDb(),
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

        registerCommonHandlers(this.rpcHandlerManager, process.cwd());

        // Keep issued previews and apply locks alive across socket reconnections.
        const runner = createProcessRunner();
        const sharedDependencies = {
            runner,
            resolveExecutable,
            env: process.env,
            platform: process.platform,
            architecture: process.arch,
            now: Date.now,
        };
        const homeDirectory = homedir();
        const resolveRealpath = async (path: string): Promise<string | null> => realpath(path).catch(() => null);
        const environmentService = createEnvironmentService([
            createGitHubCliAdapter({ ...sharedDependencies, resolveRealpath }),
            createPawsCliAdapter({ ...sharedDependencies, resolveRealpath }),
            createEgoBrowserAdapter({
                ...sharedDependencies,
                homeDirectory,
                readPlistValue: async (path, key) => {
                    const inspected = await runner.run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path], {
                        timeoutMs: 5_000,
                        maxOutputBytes: 1024,
                        env: process.env,
                    });
                    const value = inspected.exitCode === 0 && !inspected.timedOut ? inspected.stdout.trim() : '';
                    return value.length > 0 ? value : null;
                },
            }),
            createWranglerAdapter({ ...sharedDependencies, resolveRealpath }),
            createCloudflaredAdapter({
                ...sharedDependencies,
                homeDirectory,
                resolveRealpath,
                pathExists: async (path) => access(path).then(() => true, () => false),
            }),
        ]);
        registerEnvironmentHandlers(this.rpcHandlerManager, environmentService);
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession,
        requestShutdown,
        refreshCodexUsage,
        refreshCodexAccountQuota,
    }: MachineRpcHandlers) {
        this.resumeSessionHandler = resumeSession ?? null;

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, approvedNewDirectoryCreation, agent, environmentVariables, token, codexSessionGrant, model, effort, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId } = params || {};
            const traceId = traceIdFromParams(params?.traceId);

            if (!directory) {
                throw new Error('Directory is required');
            }
            if ((model !== undefined || effort !== undefined) && agent !== 'codex') {
                throw new Error('Model and effort are supported only for Codex sessions');
            }
            if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
                throw new Error('Codex model must be a non-empty string');
            }
            if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
                throw new Error('Codex effort must be one of: low, medium, high, xhigh, max');
            }

            const result = await spawnSession({
                directory,
                sessionId,
                machineId: this.machine.id,
                approvedNewDirectoryCreation,
                agent,
                environmentVariables,
                token,
                codexSessionGrant,
                model,
                effort,
                resumeClaudeSessionId,
                resumeCodexThreadId,
                parentSessionId,
                forkedFromMessageId,
                ...(traceId ? { traceId } : {}),
            });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug('[API MACHINE] Directory creation approval required');
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    return { type: 'error', errorMessage: result.errorMessage };
            }
        });

        this.syncResumeSessionRpcRegistration();

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

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        if (refreshCodexUsage) {
            this.rpcHandlerManager.registerHandler('refresh-codex-usage', async () => {
                await refreshCodexUsage();
                return { type: 'success' };
            });
        }
        if (refreshCodexAccountQuota) {
            this.rpcHandlerManager.registerHandler('refresh-codex-account-quota', async (params: unknown) => {
                const grant = typeof (params as { grant?: unknown } | null)?.grant === 'string' ? (params as { grant: string }).grant : '';
                if (!/^[A-Za-z0-9_-]{43}$/.test(grant)) throw new Error('A valid Codex quota probe grant is required');
                return refreshCodexAccountQuota(grant);
            });
        }

        this.rpcHandlerManager.registerHandler('codex-list-attach-candidates', async (params: any) => {
            const rawExistingThreadIds = params?.existingThreadIds;
            if (!Array.isArray(rawExistingThreadIds) || rawExistingThreadIds.length > 5000) {
                throw new Error('existingThreadIds must be an array with at most 5000 entries');
            }
            const existingThreadIds = rawExistingThreadIds.filter(
                (value: unknown): value is string => typeof value === 'string' && value.length > 0,
            );
            return {
                candidates: await this.codexAttachCandidates.list({ existingThreadIds }),
            };
        });

        this.rpcHandlerManager.registerHandler('codex-dismiss-attach-candidate', async (params: any) => {
            const threadId = requireNonEmptyString(params?.threadId, 'threadId');
            await this.codexAttachCandidates.dismiss(threadId);
            return { type: 'success' };
        });

        this.rpcHandlerManager.registerHandler('codex-attach-candidate', async (params: any) => {
            const sourceSessionId = requireNonEmptyString(params?.sourceSessionId, 'sourceSessionId (Codex source history unavailable)');
            const threadId = requireNonEmptyString(params?.threadId, 'threadId');
            const candidates = await this.codexAttachCandidates.list({ existingThreadIds: [] });
            const candidate = candidates.find((item) => item.threadId === threadId);
            if (!candidate) {
                throw new Error('Codex Desktop thread is no longer available for attachment');
            }

            const forked = await withCodexAccountThread({ sourceSessionId, codexThreadId: candidate.threadId }, async (client) => {
                const { thread } = await client.readThread({
                    threadId: candidate.threadId,
                    includeTurns: true,
                });
                const latestTurn = (thread.turns ?? []).at(-1);
                if (latestTurn && !isTerminalCodexTurn(latestTurn)) {
                    throw new Error('Codex Desktop thread is still running; wait for the current response to finish and try again');
                }
                return forkCodexThread(client, {
                    threadId: candidate.threadId,
                    cwd: candidate.directory,
                    ...(latestTurn ? { lastTurnId: latestTurn.id } : {}),
                    deferGoalContinuation: true,
                });
            });

            let result: SpawnSessionResult;
            try {
                result = await spawnSession({
                    directory: candidate.directory,
                    agent: 'codex',
                    codexSessionGrant: params?.codexSessionGrant,
                    parentSessionId: sourceSessionId,
                    resumeCodexThreadId: forked.newCodexThreadId,
                    environmentVariables: {
                        // Resume the fork through the normal private app-server.
                        // The Desktop-owned source can keep its active writer while
                        // Paws exclusively owns and continues the copied history.
                        HAPPY_IMPORTED_SESSION_TITLE: candidate.title.slice(0, 200),
                    },
                });
            } catch (error) {
                await deleteFailedCodexTakeoverFork(forked.newCodexThreadId, sourceSessionId);
                throw error;
            }

            if (result.type === 'success') {
                await this.codexAttachCandidates.markAttached(threadId);
                return result;
            }
                await deleteFailedCodexTakeoverFork(forked.newCodexThreadId, sourceSessionId);
            if (result.type === 'requestToApproveDirectoryCreation') {
                throw new Error('Codex Desktop thread directory is no longer available');
            }
            throw new Error(result.errorMessage);
        });

        // Register Claude session fork handlers (used by app-side fork /
        // duplicate flows). These take the source session's working
        // directory and underlying Claude UUID, copy the on-disk JSONL
        // — optionally truncated at a chosen message — and return the new
        // Claude UUID. The caller then spawns a fresh Happy session with
        // `resumeClaudeSessionId` set so `claude --resume <newUuid>`
        // continues the conversation.
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { directory, targetDirectory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (targetDirectory !== undefined && (typeof targetDirectory !== 'string' || targetDirectory.length === 0)) {
                throw new Error('targetDirectory must be a non-empty string');
            }
            try {
                const newClaudeSessionId = await claudeForkSession(
                    getProjectPath(directory),
                    claudeSessionId,
                    getProjectPath(targetDirectory ?? directory),
                );
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        // List user-text rewind points directly from the on-disk JSONL.
        // The server-side session log misses claudeUuid for messages typed
        // live in the app (legacy `sentFrom: 'web'` path); disk is the
        // source of truth and carries the right uuids for every message.
        this.rpcHandlerManager.registerHandler('claude-list-rewind-points', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const points = await listClaudeRewindPoints(getProjectPath(directory), claudeSessionId);
                return { type: 'success', points };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('claude-duplicate-session', async (params: any) => {
            const { directory, claudeSessionId, cutAfterUuid } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (typeof cutAfterUuid !== 'string' || !UUID_RE.test(cutAfterUuid)) {
                throw new Error('cutAfterUuid must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkAndTruncateSession(
                    getProjectPath(directory),
                    claudeSessionId,
                    cutAfterUuid,
                );
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                if (error instanceof ForkTruncateUuidNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source session — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('codex-fork-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            const sourceSessionId = requireNonEmptyString(params?.sourceSessionId, 'sourceSessionId (Codex source history unavailable)');
            const result = await withCodexAccountThread({ sourceSessionId, codexThreadId }, (client) => forkCodexThread(client, {
                threadId: codexThreadId,
                cwd: directory,
                deferGoalContinuation: true,
            }));
            return result;
        });

        this.rpcHandlerManager.registerHandler('codex-list-rewind-points', async (params: any) => {
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            const sourceSessionId = requireNonEmptyString(params?.sourceSessionId, 'sourceSessionId (Codex source history unavailable)');
            return withCodexAccountThread({ sourceSessionId, codexThreadId }, async (client) => {
                const { thread } = await client.readThread({
                    threadId: codexThreadId,
                    includeTurns: true,
                });
                return {
                    type: 'success',
                    points: listCodexRewindPoints(thread),
                };
            });
        });

        this.rpcHandlerManager.registerHandler('codex-duplicate-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');
            if (params?.cutBeforeItemId !== undefined && params?.cutAfterItemId !== undefined) {
                throw new Error('Cannot combine Codex fork boundaries');
            }
            const cutBeforeItemId = params?.cutBeforeItemId === undefined
                ? undefined : requireNonEmptyString(params.cutBeforeItemId, 'cutBeforeItemId');
            const cutAfterItemId = cutBeforeItemId ? undefined : requireNonEmptyString(params?.cutAfterItemId, 'cutAfterItemId');
            const retainSelectedTurn = params?.retainSelectedTurn === true;

            try {
                const sourceSessionId = requireNonEmptyString(params?.sourceSessionId, 'sourceSessionId (Codex source history unavailable)');
                return await withCodexAccountThread({ sourceSessionId, codexThreadId }, (client) => forkCodexThread(client, {
                    threadId: codexThreadId,
                    cwd: directory,
                    cutAfterItemId,
                    cutBeforeItemId,
                    retainSelectedTurn,
                    deferGoalContinuation: true,
                }));
            } catch (error) {
                if (error instanceof CodexForkRewindPointNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source Codex thread — try forking without truncation',
                    );
                }
                throw error;
            }
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
    }

    private syncResumeSessionRpcRegistration(): void {
        const method = 'resume-happy-session';

        if (this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const { sessionId, model, permissionMode, effort, codexSessionGrant } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId, { model, permissionMode, effort, ...(codexSessionGrant !== undefined ? { codexSessionGrant } : {}) });
                    switch (result.type) {
                        case 'success':
                            return { type: 'success', sessionId: result.sessionId };
                        case 'requestToApproveDirectoryCreation':
                            return result;
                        case 'error':
                            throw new Error(result.errorMessage);
                    }
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
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
                machineId: this.machine.id,
                happyClient: `cli-daemon/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }

            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));

            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.syncResumeSessionRpcRegistration();
            this.startKeepAlive();
        });

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            this.startSmartReconnect();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string, traceId?: string }, callback: (response: string) => void) => {
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

        this.socket.on('connect_error', () => {
            logger.debug('[API MACHINE] Connection error', { errorCode: 'machine-socket-connect-error' });
            this.startSmartReconnect();
        });

        this.socket.io.on('error', () => {
            logger.debug('[API MACHINE] Socket error', { errorCode: 'machine-socket-error' });
            this.startSmartReconnect();
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) {
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);

            // Re-detect CLI availability and push metadata update if changed
            const newAvailability = detectCLIAvailability();
            const prev = this.lastKnownCLIAvailability;
            const newResumeSupport = detectResumeSupport();
            const prevResume = this.lastKnownResumeSupport;
            const cliAvailabilityChanged = !prev
                || prev.ask !== newAvailability.ask
                || prev.claude !== newAvailability.claude
                || prev.codex !== newAvailability.codex
                || prev.gemini !== newAvailability.gemini
                || prev.opencode !== newAvailability.opencode
                || prev.openclaw !== newAvailability.openclaw;
            const resumeSupportChanged = !prevResume
                || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
                || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;

            if (cliAvailabilityChanged || resumeSupportChanged) {
                this.lastKnownCLIAvailability = newAvailability;
                this.lastKnownResumeSupport = newResumeSupport;
                this.updateMachineMetadata((metadata) => ({
                    ...(metadata || {} as any),
                    cliAvailability: newAvailability,
                    resumeSupport: { ...newResumeSupport, rpcAvailable: !!this.resumeSessionHandler },
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
                });
            }
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    isConnected(): boolean {
        return this.socket?.connected === true;
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API MACHINE] Still not ready to reconnect');
                return;
            }
            logger.debug('[API MACHINE] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API MACHINE] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
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
        this.stopKeepAlive();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}
