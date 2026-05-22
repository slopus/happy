/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { resolveAllowedRoot } from '../modules/common/resolveAllowedRoot';
import { homedir } from 'node:os';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import type { PortRegistry } from '@/daemon/portRegistry';
import { proxyHttp, PreviewProxyError } from '@/daemon/previewProxy';
import { startServerProcess, StartServerError } from '@/daemon/startServer';
import packageJson from '../../package.json';
import { stopServerProcess, StopServerError } from '@/daemon/stopServer';
import { createPtySession } from '@/daemon/remoteTerminal';
import { decideTerminalCwd, formatCwdFallbackBanner } from '@/daemon/decideTerminalCwd';
import { validatePath } from '@/modules/common/pathSecurity';
import { existsSync, mkdirSync } from 'node:fs';
import {
    addDaemonTerminalSession,
    getDaemonTerminalSession,
    killAllDaemonTerminalSessions,
    recordBytesIn,
    recordBytesOut,
    removeDaemonTerminalSession,
} from '@/daemon/daemonTerminalSessions';
import type { ChildProcess } from 'node:child_process';

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'proxy-http-request': (
        params: {
            port: number;
            method: string;
            path: string;
            headers: Record<string, string>;
            bodyB64: string | null;
        },
        ack: (response: unknown) => void,
    ) => void;
    // specs/remote-terminal/ Phase 2 — server forwards terminal control
    // events here. `params` / `data` payloads are E2EE between the
    // daemon and the originating client; happy-server only routes them.
    'terminal-open-fwd': (
        msg: { sessionId: string; params: string | null },
        ack: (response: unknown) => void,
    ) => void;
    'terminal-frame-fwd': (msg: { sessionId: string; data: string }) => void;
    'terminal-resize-fwd': (msg: { sessionId: string; cols: number; rows: number }) => void;
    'terminal-close-fwd': (msg: { sessionId: string }) => void;
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
    // specs/remote-terminal/ Phase 2 — daemon-originated stream frames.
    // `data` is the E2EE-encrypted PTY chunk; happy-server forwards it
    // to the client without inspection.
    'terminal-frame': (msg: { sessionId: string; data: string }) => void;
    'terminal-closed': (msg: { sessionId: string; code: number; signal: number | null }) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
    portRegistry: PortRegistry;
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    // specs/20260521-happy-cli-version-republish — daemon 재시작 후 새 cli
    // 버전을 server metadata 에 re-publish 못 하던 회귀 fix. null 초기
    // 이므로 첫 keep-alive 가 무조건 publish 하여 stale 한 server-side
    // happyCliVersion 을 갱신한다.
    private lastKnownCliVersion: string | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private resumeSessionHandler: ((sessionId: string) => Promise<SpawnSessionResult>) | null = null;
    // specs/remote-terminal-cwd-fallback/ — cached so the
    // terminal-open-fwd handler can run validatePath against the same
    // root the rest of the RPC surface uses (Files tab / writeFile).
    private allowedRoot: string;

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

        // specs/daemon-rpc-workspace-rebase/ Phase 2 — rebase the
        // path-validation root for machine-scoped RPCs (getDirectoryTree
        // / readFile / writeFile / etc.) onto the user's home directory
        // (or HAPPY_WORKSPACE_ROOT if the operator explicitly puts the
        // workspace outside home, e.g. /opt/work). Previously this used
        // process.cwd(), which made the RPC surface depend on whichever
        // shell the user happened to start `happy daemon start` in,
        // breaking the cross-identity Files tab when the daemon was
        // launched from / or any directory that doesn't enclose the
        // project's workspaceDir.
        const allowedRoot = resolveAllowedRoot({
            registryWorkspaceRoot: process.env.HAPPY_WORKSPACE_ROOT ?? null,
            homeDir: homedir(),
        });
        this.allowedRoot = allowedRoot;
        registerCommonHandlers(this.rpcHandlerManager, allowedRoot);
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession,
        requestShutdown,
        portRegistry
    }: MachineRpcHandlers) {
        this.resumeSessionHandler = resumeSession ?? null;

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token, happyToken, happySecret } = params || {};
            logger.debug(`[API MACHINE] Spawning session: dir=${directory}, hasUserCreds=${!!(happyToken && happySecret)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token, happyToken, happySecret });

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

        this.syncResumeSessionRpcRegistration(detectResumeSupport().rpcAvailable);

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

        // Register port allocation handler — sticky per (user, project)
        // composite key in 30000-40000 since specs/preview-cross-user-
        // isolation/ Phase 4. Both userId and projectId are required.
        this.rpcHandlerManager.registerHandler('allocate-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const result = await portRegistry.allocate(userId, projectId);
            logger.debug(`[API MACHINE] allocate-port ${userId}:${projectId} -> ${result.port} (reused=${result.reused})`);
            return result;
        });

        // Register read-only port lookup handler. Used by web-ui preflight
        // (specs/preview-server-lifecycle/ Phase 1) to check whether a (user,
        // project) already has a sticky port assigned before deciding to
        // start a new server. Falls back to the legacy bare-projectId entry
        // so daemons that have not yet seen the new composite key still
        // resolve the right port for the original owner.
        this.rpcHandlerManager.registerHandler('get-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const data = await portRegistry.readAll();
            const entry = data[`${userId}:${projectId}`] ?? data[projectId];
            const port = entry ? entry.port : null;
            logger.debug(`[API MACHINE] get-port ${userId}:${projectId} -> ${port}`);
            return { port };
        });

        // Register port release handler (e.g., on project deletion). userId
        // is required to scope the release to the correct (user, project).
        this.rpcHandlerManager.registerHandler('release-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const released = await portRegistry.release(userId, projectId);
            logger.debug(`[API MACHINE] release-port ${userId}:${projectId} -> released=${released}`);
            return { released };
        });

        // Register dev-server spawn handler — the web-ui hits this when
        // Phase 12 "direct server start" runs on a remote-machine session.
        // Returns an explicit {type:'success'|'error', ...} envelope so the
        // caller sees the StartServerError code (CWD_NOT_FOUND, ENOENT,
        // ...). See specs/remote-server-start/ Phase 3.
        const spawnedServers = new Map<number, ChildProcess>();
        this.rpcHandlerManager.registerHandler('start-server', async (params: any) => {
            const { command, cwd, env } = params || {};
            if (typeof command !== 'string' || typeof cwd !== 'string') {
                return { type: 'error', code: 'INVALID_REQUEST', message: 'command and cwd are required' };
            }
            try {
                const result = await startServerProcess(
                    { command, cwd, env },
                    {
                        fastFailDelayMs: 50,
                        onSpawn: (child) => {
                            if (child.pid) {
                                spawnedServers.set(child.pid, child);
                                child.on('exit', () => spawnedServers.delete(child.pid!));
                            }
                        },
                    },
                );
                logger.debug(`[API MACHINE] start-server spawned pid=${result.pid} cwd=${cwd}`);
                return { type: 'success', pid: result.pid };
            } catch (e) {
                if (e instanceof StartServerError) {
                    logger.debug(`[API MACHINE] start-server failed: ${e.code} ${e.message}`);
                    return { type: 'error', code: e.code, message: e.message };
                }
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] start-server internal error: ${message}`);
                return { type: 'error', code: 'INTERNAL', message };
            }
        });

        // Companion to `start-server` — signals the child with SIGTERM,
        // falling back to SIGKILL if it does not exit gracefully. Envelope
        // matches start-server: success or {code,message} error.
        // See specs/preview-server-lifecycle/ Phase 5a.
        this.rpcHandlerManager.registerHandler('stop-server', async (params: any) => {
            const { pid } = params || {};
            if (typeof pid !== 'number') {
                return { type: 'error', code: 'INVALID_REQUEST', message: 'pid is required' };
            }
            try {
                const result = await stopServerProcess({ pid });
                logger.debug(`[API MACHINE] stop-server pid=${pid} signal=${result.sentSignal}`);
                return { type: 'success', sentSignal: result.sentSignal };
            } catch (e) {
                if (e instanceof StopServerError) {
                    logger.debug(`[API MACHINE] stop-server failed: ${e.code} ${e.message}`);
                    return { type: 'error', code: e.code, message: e.message };
                }
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] stop-server internal error: ${message}`);
                return { type: 'error', code: 'INTERNAL', message };
            }
        });

        // NOTE: proxy-http is intentionally wired as a plain socket event
        // (see connect() — 'proxy-http-request') instead of an encrypted
        // RpcHandlerManager handler. happy-server's preview relay route
        // terminates iframe requests and needs to forward plaintext bodies
        // — it has no access to the machine encryption key, so the E2EE
        // RPC envelope can't be used. The preview payload is inherently
        // non-sensitive (it's the HTTP request flowing from the iframe,
        // and happy-server already sees it to rewrite HTML).
    }

    private syncResumeSessionRpcRegistration(rpcAvailable: boolean): void {
        const method = 'resume-happy-session';

        if (rpcAvailable && this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const { sessionId } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId);
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
            this.syncResumeSessionRpcRegistration(detectResumeSupport().rpcAvailable);

            // Start keep-alive
            this.startKeepAlive();
        });

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from server');
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            // specs/remote-terminal/ Phase 2 — relay path is broken once
            // the socket drops, and the server's session map entry now
            // points at a dead socket. Kill local PTYs so no orphans
            // outlive the daemon's connection. The 30s grace timer (Q4)
            // is deferred to a future remote-terminal-detach-attach spec
            // since it requires server+daemon coordinated state for any
            // real reattach value (Phase 5 review).
            const killed = killAllDaemonTerminalSessions('SIGTERM');
            if (killed > 0) {
                logger.debug(`[API MACHINE] Killed ${killed} terminal session(s) on disconnect`);
            }
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Plain-text preview proxy channel — happy-server relays iframe HTTP
        // requests here without encryption because it needs to inspect/rewrite
        // response bodies (HTML path rewriting) and has no access to the
        // machine encryption key anyway. Independent of the rpc-request
        // pipeline above.
        this.socket.on(
            'proxy-http-request',
            async (params: any, ack: (response: any) => void) => {
                try {
                    const result = await proxyHttp({
                        port: params?.port,
                        method: params?.method,
                        path: params?.path,
                        headers: params?.headers ?? {},
                        bodyB64: params?.bodyB64 ?? null,
                    });
                    logger.debug(
                        `[API MACHINE] proxy-http-request ${params?.method} ${params?.path} -> ${result.status}${result.truncated ? ' (truncated)' : ''}`,
                    );
                    ack({ type: 'success', ...result });
                } catch (e) {
                    if (e instanceof PreviewProxyError) {
                        logger.debug(`[API MACHINE] proxy-http-request failed: ${e.code} ${e.message}`);
                        ack({ type: 'error', code: e.code, message: e.message });
                        return;
                    }
                    const message = e instanceof Error ? e.message : String(e);
                    logger.debug(`[API MACHINE] proxy-http-request internal error: ${message}`);
                    ack({ type: 'error', code: 'INTERNAL', message });
                }
            },
        );

        // specs/remote-terminal/ Phase 2 — interactive PTY relay.
        //
        // happy-server has already gated this on userId-owns-machineId
        // (terminalRelayHandler.ts ACL) so by the time `terminal-open-fwd`
        // arrives the daemon trusts the request. The `params` blob is
        // E2EE-encrypted by the originating client with the same key the
        // rpc-call pipeline uses; we decrypt to extract cols/rows/cwd/etc.
        // PTY stdout is encrypted on this side before being forwarded as
        // `terminal-frame`, so happy-server never sees plaintext.
        const machineKey = this.machine.encryptionKey;
        const machineVariant = this.machine.encryptionVariant;
        const machineId = this.machine.id;
        this.socket.on('terminal-open-fwd', async (msg, ack) => {
            try {
                const { sessionId, params } = msg || {};
                if (!sessionId || typeof sessionId !== 'string') {
                    ack({ ok: false, error: 'sessionId is required' });
                    return;
                }
                let opts: any = null;
                if (params && typeof params === 'string') {
                    try {
                        opts = decrypt(machineKey, machineVariant, decodeBase64(params));
                    } catch (e) {
                        logger.debug(`[API MACHINE] terminal-open-fwd decrypt failed: ${(e as Error).message}`);
                        ack({ ok: false, error: 'Failed to decrypt open params' });
                        return;
                    }
                }
                const auditUserId = typeof opts?.userId === 'string' ? opts.userId : 'remote-client';
                // specs/remote-terminal-cwd-fallback/ — never let
                // pty.spawn() chdir into a path that may not exist on
                // this daemon. decideTerminalCwd validates, auto-mkdirs
                // when safe, and falls back to homedir otherwise so the
                // user always gets a working shell instead of node-pty's
                // raw `chdir(2) failed.: No such file or directory`.
                const cwdDecision = decideTerminalCwd({
                    requested: typeof opts?.cwd === 'string' ? opts.cwd : undefined,
                    allowedRoot: this.allowedRoot,
                    homedir: homedir(),
                    fsExists: existsSync,
                    fsMkdir: (path) => mkdirSync(path, { recursive: true }),
                    validate: validatePath,
                });
                let pty: ReturnType<typeof createPtySession>;
                try {
                    pty = createPtySession({
                        userId: auditUserId,
                        shell: typeof opts?.shell === 'string' ? opts.shell : undefined,
                        args: Array.isArray(opts?.args) ? opts.args : undefined,
                        cwd: cwdDecision.cwd,
                        env: opts?.env && typeof opts.env === 'object' ? opts.env : undefined,
                        cols: Number.isInteger(opts?.cols) ? opts.cols : undefined,
                        rows: Number.isInteger(opts?.rows) ? opts.rows : undefined,
                    });
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    logger.debug(`[API MACHINE] terminal-open-fwd spawn failed: ${message}`);
                    ack({ ok: false, error: message });
                    return;
                }
                const entry = addDaemonTerminalSession(sessionId, pty, {
                    userId: auditUserId,
                    machineId,
                });
                // Emit the fallback banner BEFORE registering pty.onData
                // so the dim ANSI notice always lands ahead of the
                // shell's first prompt chunk in the terminal-frame
                // stream. Encrypt with the same machine key the regular
                // frames use; happy-server forwards untouched.
                if (cwdDecision.fallback) {
                    const banner = formatCwdFallbackBanner(cwdDecision);
                    if (banner) {
                        try {
                            const data = encodeBase64(encrypt(machineKey, machineVariant, banner));
                            this.socket.emit('terminal-frame', { sessionId, data });
                            recordBytesOut(sessionId, banner.length);
                        } catch (e) {
                            logger.debug(`[API MACHINE] terminal-open-fwd banner encrypt failed: ${(e as Error).message}`);
                        }
                    }
                    logger.debug(
                        `[REMOTE-TERMINAL] cwd-fallback session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} ` +
                        `requested=${cwdDecision.fallback.requested} fallback=${cwdDecision.cwd} reason=${cwdDecision.fallback.reason}` +
                        (cwdDecision.fallback.error ? ` error=${JSON.stringify(cwdDecision.fallback.error)}` : ''),
                    );
                }
                pty.onData((chunk) => {
                    recordBytesOut(sessionId, chunk.length);
                    try {
                        const data = encodeBase64(encrypt(machineKey, machineVariant, chunk));
                        this.socket.emit('terminal-frame', { sessionId, data });
                    } catch (e) {
                        logger.debug(`[API MACHINE] terminal-frame encrypt failed: ${(e as Error).message}`);
                    }
                });
                pty.onExit((code, signal) => {
                    this.socket.emit('terminal-closed', { sessionId, code, signal });
                    const closedAt = Date.now();
                    // Audit log per specs/remote-terminal/ §3 #7. Body is
                    // intentionally NOT recorded — only metadata. logger.debug
                    // writes to the daemon log file without disrupting an
                    // interactive Claude session sharing the terminal.
                    logger.debug(
                        `[REMOTE-TERMINAL] close session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} ` +
                        `exitCode=${code} signal=${signal ?? 'null'} bytesIn=${entry.bytesIn} bytesOut=${entry.bytesOut} ` +
                        `durationMs=${closedAt - entry.openedAt}`,
                    );
                    removeDaemonTerminalSession(sessionId);
                });
                logger.debug(
                    `[REMOTE-TERMINAL] open session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} pid=${pty.pid}`,
                );
                ack({ ok: true, pid: pty.pid });
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] terminal-open-fwd internal error: ${message}`);
                ack({ ok: false, error: 'Internal error' });
            }
        });

        this.socket.on('terminal-frame-fwd', (msg) => {
            const { sessionId, data } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry || typeof data !== 'string') return;
            try {
                const chunk = decrypt(machineKey, machineVariant, decodeBase64(data));
                if (typeof chunk === 'string') {
                    entry.session.write(chunk);
                    recordBytesIn(sessionId, chunk.length);
                }
            } catch (e) {
                logger.debug(`[API MACHINE] terminal-frame-fwd decrypt failed: ${(e as Error).message}`);
            }
        });

        this.socket.on('terminal-resize-fwd', (msg) => {
            const { sessionId, cols, rows } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry) return;
            if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
            entry.session.resize(cols, rows);
        });

        this.socket.on('terminal-close-fwd', (msg) => {
            const { sessionId } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry) return;
            entry.session.kill('SIGTERM');
            // onExit handler clears the entry; remove explicitly in case
            // the kill races with reconnect.
            removeDaemonTerminalSession(sessionId);
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
            if (process.env.DEBUG) {
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);

            // Re-detect CLI availability and push metadata update if changed
            const newAvailability = detectCLIAvailability();
            const prev = this.lastKnownCLIAvailability;
            const newResumeSupport = detectResumeSupport();
            const prevResume = this.lastKnownResumeSupport;
            const newCliVersion = packageJson.version;
            const prevCliVersion = this.lastKnownCliVersion;
            const cliAvailabilityChanged = !prev || prev.claude !== newAvailability.claude || prev.codex !== newAvailability.codex || prev.gemini !== newAvailability.gemini || prev.openclaw !== newAvailability.openclaw;
            const resumeSupportChanged = !prevResume
                || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
                || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;
            const cliVersionChanged = prevCliVersion !== newCliVersion;

            this.syncResumeSessionRpcRegistration(newResumeSupport.rpcAvailable);

            if (cliAvailabilityChanged || resumeSupportChanged || cliVersionChanged) {
                this.lastKnownCLIAvailability = newAvailability;
                this.lastKnownResumeSupport = newResumeSupport;
                this.lastKnownCliVersion = newCliVersion;
                this.updateMachineMetadata((metadata) => ({
                    ...(metadata || {} as any),
                    cliAvailability: newAvailability,
                    resumeSupport: newResumeSupport,
                    happyCliVersion: newCliVersion,
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
                });
            }
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
        this.stopKeepAlive();
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}
