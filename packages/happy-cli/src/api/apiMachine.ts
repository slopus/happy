/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import { shouldReconnect } from '@/utils/lidState';
import { TerminalManager } from '@/terminal/terminalManager';
import {
    ApprovalPolicy,
    TerminalInputFrame,
    TerminalOutputEvent,
    TerminalOutputFrame,
    TERMINAL_FRAME_VERSION,
} from '@/terminal/types';
import { getProjectPath } from '@/claude/utils/path';
import {
    forkSession as claudeForkSession,
    forkAndTruncateSession as claudeForkAndTruncateSession,
    listClaudeRewindPoints,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from '@/claude/utils/claudeSessionFork';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    listCodexRewindPoints,
} from '@/codex/codexThreadFork';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    'terminal:input': (data: { terminalId: string; payload: string }) => void;
    'terminal:resize': (data: { terminalId: string; payload: string }) => void;
    'terminal:signal': (data: { terminalId: string; payload: string }) => void;
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

    'terminal:register': (data: { terminalId: string }) => void;
    'terminal:unregister': (data: { terminalId: string }) => void;
    'terminal:epoch': (data: { terminalId: string; payload: string }) => void;
    'terminal:output': (data: { terminalId: string; payload: string }) => void;
    'terminal:exit': (data: { terminalId: string; payload: string }) => void;
    'terminal:control-ack': (data: { terminalId: string; payload: string }) => void;
    'terminal:control-nack': (data: { terminalId: string; payload: string }) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
    terminalManager?: TerminalManager;
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

async function withCodexAppServerClient<T>(handler: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const client = new CodexAppServerClient();
    await client.connect();
    try {
        return await handler(client);
    } finally {
        await client.disconnect();
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private resumeSessionHandler: ((sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>) | null = null;
    private reconnectInterval: NodeJS.Timeout | null = null;
    private terminalManager: TerminalManager | null = null;
    private terminalBackpressureTimer: NodeJS.Timeout | null = null;
    private terminalBackpressured = false;

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

        // null = unrestricted: the daemon serves the whole machine, and its
        // process.cwd() is an accident of where it was started, not a workspace.
        registerCommonHandlers(this.rpcHandlerManager, null);
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession,
        requestShutdown,
        terminalManager
    }: MachineRpcHandlers) {
        this.resumeSessionHandler = resumeSession ?? null;
        this.terminalManager = terminalManager ?? null;

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, permissionMode, modelMode, effortLevel, environmentVariables, token, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, isSideChat } = params || {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, machineId, approvedNewDirectoryCreation, agent, permissionMode, modelMode, effortLevel, environmentVariables, token, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, isSideChat });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
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

        // Register Claude session fork handlers (used by app-side fork /
        // duplicate flows). These take the source session's working
        // directory and underlying Claude UUID, copy the on-disk JSONL
        // — optionally truncated at a chosen message — and return the new
        // Claude UUID. The caller then spawns a fresh Happy session with
        // `resumeClaudeSessionId` set so `claude --resume <newUuid>`
        // continues the conversation.
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkSession(getProjectPath(directory), claudeSessionId);
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

            const result = await withCodexAppServerClient((client) => forkCodexThread(client, {
                threadId: codexThreadId,
                cwd: directory,
            }));
            return result;
        });

        this.rpcHandlerManager.registerHandler('codex-list-rewind-points', async (params: any) => {
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            return withCodexAppServerClient(async (client) => {
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
            const cutAfterItemId = requireNonEmptyString(params?.cutAfterItemId, 'cutAfterItemId');

            try {
                return await withCodexAppServerClient((client) => forkCodexThread(client, {
                    threadId: codexThreadId,
                    cwd: directory,
                    cutAfterItemId,
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

        if (this.terminalManager) {
            this.registerTerminalRpcHandlers();
        }
    }

    private registerTerminalRpcHandlers(): void {
        const manager = this.terminalManager;
        if (!manager) {
            return;
        }

        this.rpcHandlerManager.registerHandler('terminal-create', async (params: any) => {
            const { name, cwd, shell, cols, rows } = params || {};
            if (typeof cwd !== 'string' || cwd.length === 0) {
                throw new Error('cwd is required');
            }
            const result = await manager.create({
                name: typeof name === 'string' ? name : undefined,
                cwd,
                shell: typeof shell === 'string' ? shell : undefined,
                cols: typeof cols === 'number' ? cols : 80,
                rows: typeof rows === 'number' ? rows : 24,
            });
            if (result.type === 'success') {
                this.registerTerminalStream(result.terminalId);
            }
            return result;
        });

        this.rpcHandlerManager.registerHandler('terminal-approve', async (params: any) => {
            const { approvalId } = params || {};
            if (typeof approvalId !== 'string' || approvalId.length === 0) {
                throw new Error('approvalId is required');
            }
            const result = await manager.approve(approvalId);
            if (result.type === 'success') {
                this.registerTerminalStream(result.terminalId);
            }
            return result;
        });

        this.rpcHandlerManager.registerHandler('terminal-attach', async (params: any) => {
            const { terminalId, lastSeq } = params || {};
            if (typeof terminalId !== 'string' || terminalId.length === 0) {
                throw new Error('terminalId is required');
            }
            return manager.attach(terminalId, typeof lastSeq === 'number' ? lastSeq : 0);
        });

        this.rpcHandlerManager.registerHandler('terminal-list', async () => manager.list());

        this.rpcHandlerManager.registerHandler('terminal-get-policy', async () => ({
            policy: manager.policyStore.get(),
        }));

        this.rpcHandlerManager.registerHandler('terminal-close', async (params: any) => {
            const { terminalId } = params || {};
            if (typeof terminalId !== 'string' || terminalId.length === 0) {
                throw new Error('terminalId is required');
            }
            await manager.close(terminalId);
            this.socket?.emit('terminal:unregister', { terminalId });
            return { success: true };
        });

        this.rpcHandlerManager.registerHandler('terminal-set-policy', async (params: any) => {
            const { policy } = params || {};
            if (typeof policy !== 'string') {
                throw new Error('policy is required');
            }
            await manager.policyStore.set(policy as ApprovalPolicy);
            return { policy: manager.policyStore.get() };
        });
    }

    private syncResumeSessionRpcRegistration(): void {
        const method = 'resume-happy-session';

        if (this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const { sessionId, model, permissionMode } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId, { model, permissionMode });
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
            this.registerTerminalStreams();
            this.startKeepAlive();
            this.startTerminalBackpressureMonitoring();
        });

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            this.startSmartReconnect();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Terminal streaming plane (encrypted frames relayed by the server).
        this.socket.on('terminal:input', (data) => this.handleTerminalFrame('input', data));
        this.socket.on('terminal:resize', (data) => this.handleTerminalFrame('resize', data));
        this.socket.on('terminal:signal', (data) => this.handleTerminalFrame('signal', data));

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
            this.startSmartReconnect();
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private sendKeepAlive() {
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
        const cliAvailabilityChanged = !prev || prev.claude !== newAvailability.claude || prev.codex !== newAvailability.codex || prev.gemini !== newAvailability.gemini || prev.openclaw !== newAvailability.openclaw;
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
    }

    emitTerminalOutput(terminalId: string, frame: TerminalOutputEvent): void {
        if (!this.socket?.connected) {
            // The ring buffer + attach snapshot are the recovery path; never
            // build an unbounded Socket.IO outbound queue while offline.
            return;
        }
        this.socket.emit('terminal:output', {
            terminalId,
            payload: this.encryptFrame(this.enrichOutputFrame(terminalId, frame)),
        });
    }

    emitTerminalExit(terminalId: string, frame: TerminalOutputEvent): void {
        if (!this.socket?.connected) {
            return;
        }
        this.socket.emit('terminal:exit', {
            terminalId,
            payload: this.encryptFrame(this.enrichOutputFrame(terminalId, frame)),
        });
    }

    emitTerminalError(terminalId: string, frame: TerminalOutputEvent): void {
        // Errors travel on the output channel; clients branch on frame.kind.
        this.emitTerminalOutput(terminalId, frame);
    }

    private registerTerminalStreams(): void {
        if (!this.terminalManager) {
            return;
        }
        for (const terminalId of this.terminalManager.getRunningTerminalIds()) {
            this.registerTerminalStream(terminalId);
        }
    }

    private registerTerminalStream(terminalId: string): void {
        if (!this.terminalManager) {
            return;
        }
        this.socket.emit('terminal:register', { terminalId });
        this.socket.emit('terminal:epoch', {
            terminalId,
            payload: this.encryptFrame(this.enrichOutputFrame(terminalId, {
                seq: 0,
                kind: 'epoch',
            })),
        });
    }

    private handleTerminalFrame(
        kind: TerminalInputFrame['kind'],
        data: { terminalId: string; payload: string },
    ): void {
        if (!this.terminalManager) {
            return;
        }
        const { terminalId, payload } = data ?? {};
        if (typeof terminalId !== 'string' || typeof payload !== 'string') {
            return;
        }

        let frame: TerminalInputFrame;
        try {
            frame = this.decryptFrame<TerminalInputFrame>(payload);
        } catch (error) {
            logger.debug('[API MACHINE] Failed to decrypt terminal frame:', error);
            return;
        }
        if (!frame
            || frame.version !== TERMINAL_FRAME_VERSION
            || frame.direction !== 'client-to-daemon'
            || frame.terminalId !== terminalId
            || frame.machineId !== this.machine.id
            || frame.kind !== kind) {
            // Routing metadata is authenticated inside the ciphertext: a
            // misrouted or replayed frame from a compromised relay is dropped.
            logger.debug('[API MACHINE] Rejected terminal frame (binding mismatch)');
            return;
        }

        try {
            const result = this.terminalManager.applyFrame(terminalId, frame);
            if (result.status === 'applied' || result.status === 'duplicate') {
                this.emitTerminalControlAck(
                    terminalId,
                    frame.streamId,
                    frame.seq,
                    result.status,
                );
            } else {
                this.emitTerminalControlNack(
                    terminalId,
                    frame.streamId,
                    frame.seq,
                    result.expectedSeq,
                    result.status,
                );
                logger.debug('[API MACHINE] Terminal frame rejected', { kind, status: result.status });
            }
        } catch (error) {
            logger.debug('[API MACHINE] Terminal frame handling failed:', error);
        }
    }

    private emitTerminalControlAck(
        terminalId: string,
        streamId: string,
        seq: number,
        status: 'applied' | 'duplicate',
    ): void {
        if (!this.socket.connected) {
            return;
        }
        this.socket.emit('terminal:control-ack', {
            terminalId,
            payload: this.encryptFrame(this.enrichOutputFrame(terminalId, {
                seq,
                streamId,
                kind: 'control-ack' as const,
                status,
            })),
        });
    }

    private emitTerminalControlNack(
        terminalId: string,
        streamId: string,
        receivedSeq: number,
        expectedSeq: number,
        reason: 'gap' | 'invalid',
    ): void {
        if (!this.socket.connected) {
            return;
        }
        this.socket.emit('terminal:control-nack', {
            terminalId,
            payload: this.encryptFrame(this.enrichOutputFrame(terminalId, {
                seq: receivedSeq,
                streamId,
                kind: 'control-nack' as const,
                receivedSeq,
                expectedSeq,
                reason,
            })),
        });
    }

    private enrichOutputFrame(
        terminalId: string,
        frame: {
            seq: number;
            streamId?: string;
            kind: TerminalOutputFrame['kind'];
            data?: string;
            exitCode?: number;
            error?: string;
            status?: 'applied' | 'duplicate';
            receivedSeq?: number;
            expectedSeq?: number;
            reason?: 'gap' | 'invalid';
        },
    ): TerminalOutputFrame {
        const epoch = this.terminalManager?.getStreamEpoch();
        if (!epoch) {
            throw new Error('Terminal manager epoch is unavailable');
        }
        return {
            ...frame,
            version: TERMINAL_FRAME_VERSION,
            epoch,
            terminalId,
            machineId: this.machine.id,
            direction: 'daemon-to-client',
        };
    }

    private encryptFrame(frame: unknown): string {
        return encodeBase64(encrypt(
            this.machine.encryptionKey,
            this.machine.encryptionVariant,
            frame,
        ));
    }

    private decryptFrame<T>(payload: string): T {
        return decrypt(
            this.machine.encryptionKey,
            this.machine.encryptionVariant,
            decodeBase64(payload),
        ) as T;
    }

    /**
     * Heuristic transport backpressure: while the socket's outbound buffer
     * grows (e.g. the daemon is offline or the server is congested), pause the
     * shells; resume once the buffer drains. Exact byte accounting is not
     * available through socket.io-client, so packet count is the proxy.
     */
    private startTerminalBackpressureMonitoring(): void {
        this.stopTerminalBackpressureMonitoring();
        if (!this.terminalManager) {
            return;
        }
        this.terminalBackpressureTimer = setInterval(() => {
            this.updateTerminalBackpressure();
        }, 250);
    }

    private updateTerminalBackpressure(): void {
        if (!this.terminalManager) {
            return;
        }
        const pendingPackets = (this.socket as any)?.sendBuffer?.length ?? 0;
        const HIGH_WATER_PACKETS = 512;
        const LOW_WATER_PACKETS = 64;

        if (!this.terminalBackpressured && pendingPackets > HIGH_WATER_PACKETS) {
            this.terminalBackpressured = true;
            for (const terminalId of this.terminalManager.getRunningTerminalIds()) {
                this.terminalManager.setTransportPaused(terminalId, true);
            }
            logger.debug('[API MACHINE] Terminal transport backpressured', { pendingPackets });
        } else if (this.terminalBackpressured && pendingPackets <= LOW_WATER_PACKETS) {
            this.terminalBackpressured = false;
            for (const terminalId of this.terminalManager.getRunningTerminalIds()) {
                this.terminalManager.setTransportPaused(terminalId, false);
            }
            logger.debug('[API MACHINE] Terminal transport drained', { pendingPackets });
        }
    }

    private stopTerminalBackpressureMonitoring(): void {
        if (this.terminalBackpressureTimer) {
            clearInterval(this.terminalBackpressureTimer);
            this.terminalBackpressureTimer = null;
        }
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.sendKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            this.sendKeepAlive();
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
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
        this.stopTerminalBackpressureMonitoring();
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
