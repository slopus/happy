import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { ApiMachineClient } from './apiMachine';
import { addDaemonTerminalSession, getDaemonTerminalSession, removeDaemonTerminalSession } from '@/daemon/daemonTerminalSessions';
import { deriveServerRpcKey, encodeBase64, encrypt } from './encryption';
import { RECONNECT_DIAL_TIMEOUT_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_NOT_READY_POLL_MS } from './reconnectCadence';
import { logger } from '@/ui/logger';
import type { Machine } from './types';
import type { RpcHandlerConfig } from './rpc/types';
import { CHANNEL_SUPPORT_CAPABILITY } from '@/channel/channelSupportCapability';
import { AI_AUTH_SELECTION_CAPABILITY } from '@/daemon/sessionEnv';
import { createAiCredentialRuntime } from '@/daemon/aiCredentialRuntime';
import { join } from 'node:path';

const {
    mockIo,
    mockShouldReconnect,
    rpcManagerConfigs
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true),
    rpcManagerConfigs: [] as RpcHandlerConfig[]
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test',
        happyHomeDir: '/tmp/happy-api-machine-test',
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        constructor(config: RpcHandlerConfig) {
            rpcManagerConfigs.push(config);
        }
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
        setMethodPolicy = vi.fn();
    }
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

/** node-pty's unix build; the banner test below actually spawns a shell. */
const describeUnix = process.platform === 'win32' ? describe.skip : describe;

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary R2/R3 — the machine scope
 * also answers the server's own key, for the server lane methods only.
 */
describe('ApiMachineClient machine RPC server lane', () => {
    beforeEach(() => {
        rpcManagerConfigs.length = 0;
    });

    it('keys a dataKey machine server lane with the key derived from its machine key', () => {
        const machine: Machine = { ...makeMachine(), encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' };
        new ApiMachineClient('fake-token', machine);

        const lane = rpcManagerConfigs.at(-1)?.serverLane;
        expect(lane?.encryptionKey).toEqual(deriveServerRpcKey(machine.encryptionKey));
        expect(lane?.allows('daemon-session-state')).toBe(true);
        expect(lane?.allows('bash')).toBe(false);
    });

    it('gives a legacy machine no server lane', () => {
        new ApiMachineClient('fake-token', makeMachine());

        expect(rpcManagerConfigs.at(-1)).toBeDefined();
        expect(rpcManagerConfigs.at(-1)?.serverLane).toBeUndefined();
    });
});

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    /** Supervisor lines saying a reconnect should have been running and was not. */
    const repairLogs = () => vi.mocked(logger.debug).mock.calls
        .filter(([message]) => typeof message === 'string' && message.includes('nothing retrying'));

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        // specs/machine-socket-duplicate-registration/ — the dial cadence is
        // jittered. Pinning the source to its top of range makes each delay
        // exactly its nominal value, so these tests can assert on the clock.
        vi.spyOn(Math, 'random').mockReturnValue(1);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('refuses terminal-open-fwd with TERMINAL_DISABLED under the trial lockdown policy', async () => {
        const previous = process.env.HAPPY_REMOTE_TERMINAL_POLICY;
        process.env.HAPPY_REMOTE_TERMINAL_POLICY = 'disabled';
        try {
            const client = new ApiMachineClient('fake-token', makeMachine());
            client.connect();
            const ack = vi.fn();
            emitSocketEvent('terminal-open-fwd', { sessionId: 'term-1', params: null }, ack);
            await vi.waitFor(() => expect(ack).toHaveBeenCalled());
            expect(ack).toHaveBeenCalledWith({ ok: false, error: 'TERMINAL_DISABLED' });
        } finally {
            if (previous === undefined) delete process.env.HAPPY_REMOTE_TERMINAL_POLICY;
            else process.env.HAPPY_REMOTE_TERMINAL_POLICY = previous;
        }
    });

    /*
     * aplus-dev-studio specs/e2ee-machine-control-boundary R6 — the open params
     * are the only thing that proves the caller holds the machine key. Without
     * them, or with params sealed to another key, decrypt() used to yield null
     * and the daemon opened a login shell with defaults for whoever routed the
     * event. These run on Unix only because a regression spawns a real shell.
     */
    describeUnix('terminal-open-fwd without params the machine key opens', () => {
        const sessionId = 'term-unauthenticated-1';

        afterEach(() => {
            const entry = getDaemonTerminalSession(sessionId);
            if (entry) void entry.session.terminate();
            removeDaemonTerminalSession(sessionId);
        });

        it.each([
            ['legacy', 'missing'],
            ['legacy', 'null'],
            ['legacy', 'sealed with another key'],
            ['dataKey', 'missing'],
            ['dataKey', 'sealed with another key'],
        ] as const)('refuses %s machines %s params without opening a shell', async (variant, kind) => {
            const machine = { ...makeMachine(), encryptionVariant: variant } as Machine;
            const client = new ApiMachineClient('fake-token', machine);
            client.connect();
            const params = kind === 'missing' ? undefined
                : kind === 'null' ? null
                    : encodeBase64(encrypt(new Uint8Array(32).fill(7), variant, { shell: '/bin/sh' }));

            const ack = await new Promise<any>((resolve) => {
                emitSocketEvent('terminal-open-fwd', { sessionId, params }, resolve);
            });

            expect(ack.ok).toBe(false);
            expect(getDaemonTerminalSession(sessionId)).toBeNull();
        });
    });

    // Desktop specs/windows-build-support W0-5h: the standalone runtime roots every shell in its
    // verified pty host and closes terminals on drain, so the relay opens; the preview relay stays off.
    it('attaches the terminal relay but not the preview relay under the Windows standalone trial', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setWindowsStandaloneTrial();
        client.connect();
        for (const event of ['terminal-open-fwd', 'terminal-frame-fwd', 'terminal-resume-fwd']) {
            expect(socketHandlers[event], event).toHaveLength(1);
        }
        expect(socketHandlers['proxy-ws-open']).toBeUndefined();
    });

    /*
     * specs/desktop-terminal-reliability/ Phase 3 — the daemon side of resume.
     *
     * The buffer's own decisions are covered in terminalOutputBuffer.test.ts;
     * what these check is the wiring: that a resume reaches the buffer, that
     * each of its three answers leaves on the right event, and that a resume
     * counts as the client still being there.
     *
     * A session is registered directly rather than opened through
     * terminal-open-fwd, which would spawn a real shell (node-pty is not mocked
     * here).
     */
    describe('terminal resume', () => {
        const fakePty = () => ({
            id: 'pty', userId: 'u1', pid: 1, cols: 80, rows: 24,
            write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
            isAlive: () => true, terminate: vi.fn(async () => 'exited' as const),
            onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
        });

        const emitsOf = (event: string): any[] => mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === event)
            .map(([, payload]: [string, any]) => payload);

        afterEach(() => {
            removeDaemonTerminalSession('resume-1');
        });

        function openRegisteredSession(chunks: string[], idleTimeoutMs = 0) {
            const client = new ApiMachineClient('fake-token', makeMachine());
            client.connect();
            const entry = addDaemonTerminalSession('resume-1', fakePty() as any, {
                userId: 'u1', machineId: 'test-machine-id', idleTimeoutMs,
            });
            for (const chunk of chunks) entry.output.push(chunk);
            mockSocket.emit.mockClear();
            return { client, entry };
        }

        it('replays the frames a client missed', () => {
            openRegisteredSession(['one', 'two', 'three']);
            emitSocketEvent('terminal-resume-fwd', { sessionId: 'resume-1', afterSeq: 1 });

            expect(emitsOf('terminal-frame').map((p: any) => p.seq)).toEqual([2, 3]);
        });

        it('says nothing to a client that is already current', () => {
            openRegisteredSession(['one']);
            emitSocketEvent('terminal-resume-fwd', { sessionId: 'resume-1', afterSeq: 1 });

            expect(mockSocket.emit).not.toHaveBeenCalled();
        });

        it('sends a snapshot when the client fell past the buffer', () => {
            const { entry } = openRegisteredSession([]);
            // A tiny buffer is easier to overflow than 1,000,000 chars.
            const small = addDaemonTerminalSession('resume-1', fakePty() as any, {
                userId: 'u1', machineId: 'test-machine-id', idleTimeoutMs: 0, outputBufferChars: 6,
            });
            expect(small).not.toBe(entry);
            small.output.push('aaa');
            small.output.push('bbb');
            small.output.push('ccc');
            mockSocket.emit.mockClear();

            emitSocketEvent('terminal-resume-fwd', { sessionId: 'resume-1', afterSeq: 0 });

            expect(emitsOf('terminal-snapshot')).toHaveLength(1);
            expect(emitsOf('terminal-snapshot')[0].seq).toBe(3);
            expect(emitsOf('terminal-frame')).toHaveLength(0);
        });

        it('reports a gap rather than pretending, when nothing useful is buffered', () => {
            const session = addDaemonTerminalSession('resume-1', fakePty() as any, {
                userId: 'u1', machineId: 'test-machine-id', idleTimeoutMs: 0, outputBufferChars: 1,
            });
            const client = new ApiMachineClient('fake-token', makeMachine());
            client.connect();
            session.output.push('aaaa');
            session.output.push('bbbb');
            mockSocket.emit.mockClear();

            emitSocketEvent('terminal-resume-fwd', { sessionId: 'resume-1', afterSeq: 0 });

            expect(emitsOf('terminal-frame-gap')).toEqual([{ sessionId: 'resume-1', fromSeq: 1 }]);
        });

        it('ignores a resume for a session this daemon does not have', () => {
            openRegisteredSession(['one']);
            emitSocketEvent('terminal-resume-fwd', { sessionId: 'no-such-session', afterSeq: 0 });

            expect(mockSocket.emit).not.toHaveBeenCalled();
        });

        it('treats a missing or nonsense afterSeq as "I have seen nothing"', () => {
            openRegisteredSession(['one', 'two']);
            emitSocketEvent('terminal-resume-fwd', { sessionId: 'resume-1' });

            expect(emitsOf('terminal-frame').map((p: any) => p.seq)).toEqual([1, 2]);
        });

        /*
         * Why this matters: the client's input and the daemon's output are both
         * silent during a disconnect, so the idle watchdog keeps counting. A
         * terminal recovered at minute 14 would otherwise be torn down at 15 —
         * the 900-second teardowns seen in the incident logs.
         */
        it('counts a resume as activity so the idle watchdog restarts', () => {
            vi.useFakeTimers();
            const client = new ApiMachineClient('fake-token', makeMachine());
            client.connect();
            const pty = fakePty();
            addDaemonTerminalSession('resume-1', pty as any, {
                userId: 'u1', machineId: 'test-machine-id', idleTimeoutMs: 1000,
            });

            vi.advanceTimersByTime(900);
            emitSocketEvent('terminal-resume-fwd', { sessionId: 'resume-1', afterSeq: 0 });
            vi.advanceTimersByTime(900);
            expect(pty.terminate).not.toHaveBeenCalled();

            vi.advanceTimersByTime(200);
            expect(pty.terminate).toHaveBeenCalled();
        });
    });

    /*
     * specs/remote-terminal-cwd-fallback/ meets specs/terminal-resume/ — the
     * fallback banner is an output frame, and the ack that goes out with it
     * advertises caps.resume. A banner emitted without a seq would break that
     * promise in the same breath it is made: the client reads a missing seq as
     * "the next one after what I had", so the banner would silently consume
     * seq 1 and the shell's first real chunk would arrive looking like a
     * duplicate. It would also vanish from every replay, never having entered
     * the buffer.
     *
     * Unlike the resume tests above, this one has to go through
     * terminal-open-fwd, because that is the only place the banner is written —
     * so it spawns a real shell, and is skipped where node-pty cannot.
     */
    describeUnix('terminal-open-fwd cwd fallback banner', () => {
        const sessionId = 'banner-seq-1';

        const emitsOf = (event: string): any[] => mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === event)
            .map(([, payload]: [string, any]) => payload);

        afterEach(() => {
            removeDaemonTerminalSession(sessionId);
        });

        it('carries a seq and enters the replay buffer like any other frame', async () => {
            const machine = makeMachine();
            const client = new ApiMachineClient('fake-token', machine);
            client.connect();
            const params = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, {
                userId: 'u1',
                // Does not exist and is not under allowedRoot, so decideTerminalCwd
                // falls back to homedir and the banner is written.
                cwd: '/definitely/not/a/real/path/for/the/banner/test',
                shell: '/bin/sh',
            }));
            mockSocket.emit.mockClear();

            const ack = await new Promise<any>((resolve) => {
                emitSocketEvent('terminal-open-fwd', { sessionId, params }, resolve);
            });

            expect(ack.ok).toBe(true);
            expect(ack.caps).toEqual({ resume: true, snapshot: true });
            const banner = emitsOf('terminal-frame')[0];
            expect(banner.sessionId).toBe(sessionId);
            expect(banner.seq).toBe(1);
            // Buffered, so a client resuming from 0 gets the notice back.
            const entry = getDaemonTerminalSession(sessionId)!;
            expect(entry.output.lastSeq()).toBe(1);
            expect(entry.output.bufferedChars()).toBeGreaterThan(0);
        });
    });

    it('registers dependency reclaim on the authenticated machine RPC surface', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        expect((client as any).rpcHandlerManager.registerHandler).toHaveBeenCalledWith(
            'worktree-dependencies:reclaim', expect.any(Function),
        );
    });

    it('registers the machine-scoped Claude session transfer RPC', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;

        expect(manager.registerHandler).toHaveBeenCalledWith(
            'claude-session-transfer',
            expect.any(Function),
        );
    });

    it('registers the machine-scoped Codex thread transfer RPC', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;

        expect(manager.registerHandler).toHaveBeenCalledWith(
            'codex-thread-transfer',
            expect.any(Function),
        );
    });

    it('registers the daemon session state reader on the machine RPC surface', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const daemonSessionState = vi.fn();
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {} as any,
            daemonSessionState,
        });
        expect((client as any).rpcHandlerManager.registerHandler).toHaveBeenCalledWith(
            'daemon-session-state', daemonSessionState,
        );
    });

    it('answers whether a browser task of a session waits for the user, only on a machine with the browser runtime', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;
        const browserSessionWaiting = vi.fn(async (sessionId: string) => sessionId === 'session-1');
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {} as any,
            browserSessionWaiting,
        });
        const handler = manager.registerHandler.mock.calls.find(([name]: [string]) => name === 'browser-session-waiting')?.[1];
        expect(await handler({ sessionId: 'session-1' })).toEqual({ waiting: true });
        expect(await handler({ sessionId: 'session-2' })).toEqual({ waiting: false });
        await expect(handler({ sessionId: '' })).rejects.toThrow(/sessionId/);
        await expect(handler(null)).rejects.toThrow(/sessionId/);

        const plain = new ApiMachineClient('fake-token', makeMachine());
        plain.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {} as any,
        });
        expect((plain as any).rpcHandlerManager.registerHandler.mock.calls.some(([name]: [string]) => name === 'browser-session-waiting')).toBe(false);
    });

    it('registers the checkpoint daemon RPC surface', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;
        const checkpoint = {
            status: vi.fn(),
            list: vi.fn(),
            preview: vi.fn(),
            diff: vi.fn(),
            retireWorktree: vi.fn(),
            execute: vi.fn(),
            cancel: vi.fn(),
            retry: vi.fn(),
            decision: vi.fn(),
            restart: vi.fn(),
            refresh: vi.fn(),
        };

        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {} as any,
            checkpoint,
        });

        for (const method of Object.keys(checkpoint) as Array<keyof typeof checkpoint>) {
            expect(manager.registerHandler).toHaveBeenCalledWith(
                `checkpoint:${method === 'retireWorktree' ? 'retire-worktree' : method}`,
                checkpoint[method],
            );
        }
    });

    it('validates and forwards additional directories through the spawn RPC result', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;
        const spawnSession = vi.fn(async () => ({
            type: 'success' as const,
            sessionId: 'session-1',
            additionalDirectories: {
                version: 1 as const,
                accepted: ['/home/user/frontend'],
                skipped: { missing: 1 },
            },
        }));
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {
                capture: vi.fn(), apply: vi.fn(), status: vi.fn(), rotation: vi.fn(),
            } as any,
        });
        const spawnHandler = manager.registerHandler.mock.calls
            .find(([method]: [string]) => method === 'spawn-happy-session')?.[1];

        await expect(spawnHandler({
            directory: '/home/user/primary',
            agent: 'claude',
            additionalDirectories: ['/home/user/frontend'],
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'session-1',
            additionalDirectories: {
                version: 1,
                accepted: ['/home/user/frontend'],
                skipped: { missing: 1 },
            },
        });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            additionalDirectories: ['/home/user/frontend'],
        }));
    });

    it('exports a Codex account pool through the credential RPC when optional settings are absent', async () => {
        const accounts = { version: 3, activeIndex: 0, accounts: [
            { accountId: 'account-1', refreshToken: 'fixture-refresh', addedAt: 1, lastUsed: 1 },
        ] };
        const poolPath = join('/fixed/codex', 'multi-auth', 'openai-codex-accounts.json');
        const readFile = vi.fn(async (filePath: string) => {
            if (filePath === join('/global/node_modules', 'codex-multi-auth', 'package.json')) {
                return JSON.stringify({ version: '2.16.0' });
            }
            if (filePath === poolPath) return JSON.stringify(accounts);
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        });
        const writeFile = vi.fn(async () => undefined);
        const runtime = createAiCredentialRuntime({
            homeDir: '/home/operator', now: () => 0, env: { CODEX_HOME: '/fixed/codex' },
            execFile: vi.fn(async (command: string) => ({
                stdout: command === 'npm' ? '/global/node_modules\n' : '2.16.0\n', stderr: '',
            })),
            readFile, writeFile, readdir: vi.fn(async () => []),
            mkdir: vi.fn(async () => undefined), rename: vi.fn(async () => undefined),
            chmod: vi.fn(async () => undefined), rm: vi.fn(async () => undefined),
            makeTempDir: vi.fn(async () => '/unused'),
            supervisor: {
                enable: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
                status: vi.fn(() => ({ state: 'stopped' as const, lastErrorKind: null })),
            },
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(),
            portRegistry: {} as any, aiCredentialRuntime: runtime,
        });
        const handler = (client as any).rpcHandlerManager.registerHandler.mock.calls
            .find(([method]: [string]) => method === 'ai-credential:export')?.[1];

        expect(handler).toBeTypeOf('function');
        const captured = await handler({ provider: 'codex' });

        expect(captured.provider).toBe('codex');
        expect(JSON.parse(captured.payload)).toEqual({
            version: 1, kind: 'codex-multi-auth', packageVersion: '2.16.0', accounts,
            settings: { version: 1, pluginConfig: {} },
        });
        expect(readFile).not.toHaveBeenCalledWith(join('/fixed/codex', 'auth.json'));
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('exposes additive credential capability without receiving credentials', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const capabilities = vi.fn(() => ({ version: 1, applyModes: ['merge', 'replace'] }));
        client.setRPCHandlers({
            spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: { capabilities } as any,
        });
        const handler = (client as any).rpcHandlerManager.registerHandler.mock.calls
            .find(([method]: [string]) => method === 'ai-credential:capabilities')?.[1];
        expect(handler({})).toEqual({ version: 1, applyModes: ['merge', 'replace'] });
        expect(capabilities).toHaveBeenCalledWith();
    });

    it('rejects malformed additional directories before spawning', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const manager = (client as any).rpcHandlerManager;
        const spawnSession = vi.fn();
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(() => ({ stopped: true as const })),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {
                capture: vi.fn(), apply: vi.fn(), status: vi.fn(), rotation: vi.fn(),
            } as any,
        });
        const spawnHandler = manager.registerHandler.mock.calls
            .find(([method]: [string]) => method === 'spawn-happy-session')?.[1];

        await expect(spawnHandler({
            directory: '/home/user/primary',
            agent: 'claude',
            additionalDirectories: ['relative/path'],
        })).rejects.toThrow('Additional directories')
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        /*
         * specs/machine-socket-duplicate-registration/ AC1 — that dial has not
         * come back yet, and the next tick must not stack a second one on top
         * of it. Overlapping dials are what left the server holding several
         * live sockets for one daemon.
         */
        await vi.advanceTimersByTimeAsync(2000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // Once the dial resolves, the cadence carries on at its next tick.
        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        await vi.advanceTimersByTimeAsync(2000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    /*
     * The guard must not become a new way to never reconnect: socket.io
     * normally resolves a dial with `connect` or `connect_error`, but a
     * handshake that hangs fires neither. AC2.
     */
    it('dials again when a dial goes unanswered past its budget', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // No connect, no connect_error — nothing at all comes back.
        await vi.advanceTimersByTimeAsync(RECONNECT_DIAL_TIMEOUT_MS + RECONNECT_MAX_DELAY_MS);
        expect(mockSocket.connect.mock.calls.length).toBeGreaterThan(1);

        client.shutdown();
    });

    /*
     * A machine that says it is not ready to dial — a closed lid, a laptop that
     * has not finished waking — is not a failed dial, so `reconnectAttempts`
     * never moves and the backoff cannot pace that branch. Rescheduling from
     * the backoff there re-asks `shouldReconnect()` every base delay for as
     * long as the machine stays shut, and the predicate is not free: on macOS
     * it shells out synchronously on the daemon's only thread.
     */
    it('polls the not-ready check on its own clock rather than at the base delay', async () => {
        vi.useFakeTimers();
        mockShouldReconnect.mockReturnValue(false);

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        mockShouldReconnect.mockClear();

        const window = 60_000;
        await vi.advanceTimersByTimeAsync(window);

        // Jitter is pinned to its top of range in beforeEach, so every delay is
        // its nominal value: one window at RECONNECT_NOT_READY_POLL_MS is ~20
        // looks, against ~60 if this branch reused reconnectDelayMs(0).
        const looks = mockShouldReconnect.mock.calls.length;
        const expected = window / RECONNECT_NOT_READY_POLL_MS;
        expect(looks).toBeLessThanOrEqual(expected + 1);
        // Not-ready must not end the cadence either — it still has to notice
        // the moment the machine becomes ready.
        expect(looks).toBeGreaterThanOrEqual(expected - 1);
        // And nothing was dialled while the machine said it was not ready.
        expect(mockSocket.connect).not.toHaveBeenCalled();

        client.shutdown();
    });

    /*
     * The reconnect paths above are edge-triggered: they only run because
     * `connect_error` or `disconnect` fired. A missed edge therefore leaves a
     * daemon that is alive, heartbeating to its local state file, and holding
     * no socket at all — with nothing anywhere that ever notices. That is the
     * shape of the incident these tests exist for, so they drive the socket
     * down without emitting any edge event and assert recovery anyway.
     */
    it('reconnects a socket that never came up, with no edge event to trigger it', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        // Deliberately no connect_error and no disconnect: nothing is
        // retrying, and before the supervisor's first look nothing can be.
        await vi.advanceTimersByTimeAsync(29_000);
        expect(mockSocket.connect).not.toHaveBeenCalled();

        // The tick lands and starts the ordinary cadence with its 1s first dial.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // Still single-flight: the recovered cadence is the same cadence.
        await vi.advanceTimersByTimeAsync(3_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    /*
     * shutdown() 은 socket.close() 를 부르고, 그것이 disconnect 를 발생시킨다.
     * 그 핸들러가 재연결 cadence 를 다시 켜면 종료 절차가 이벤트 루프를 놓지
     * 못하고 run.ts 의 1초 fallback 에 걸려 `forcing exit with code 1` 로 끝난다.
     * 강제 종료는 정리를 건너뛰므로 서버는 소켓이 죽은 줄 ping 예산이 다 될
     * 때까지 모르고, 재시작 한 번이 필요 이상으로 긴 오프라인이 된다.
     */
    it('does not restart the reconnect cadence while shutting down', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        client.shutdown();

        // socket.close() 가 실제로 부르는 그 이벤트.
        emitSocketEvent('disconnect', 'io client disconnect');

        await vi.advanceTimersByTimeAsync(60_000);
        expect(mockSocket.connect).not.toHaveBeenCalled();
        expect(client.getConnectionHealth().reconnecting).toBe(false);
    });

    it('stays shut down even if a later connect_error arrives', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        client.shutdown();
        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(60_000);
        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    it('reports how long the machine socket has been down', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        await vi.advanceTimersByTimeAsync(90_000);

        expect(client.getConnectionHealth()).toEqual({
            connected: false,
            reconnecting: true,
            disconnectedForMs: 90_000
        });

        client.shutdown();
    });

    it('leaves a healthy socket alone', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        mockSocket.connected = true;

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
        expect(client.getConnectionHealth()).toEqual({
            connected: true,
            reconnecting: false,
            disconnectedForMs: null
        });

        client.shutdown();
    });

    /*
     * The supervisor's log line is the only evidence that an edge was missed,
     * so it has to stay rare enough to read as a defect. A server that is
     * simply down produces a retry cadence and no such line.
     */
    it('stays quiet while a retry is already in flight', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(repairLogs()).toHaveLength(0);

        client.shutdown();
    });

    it('reports the missed edge once, not on every tick', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        // Repaired on the first tick; every tick after it finds a live
        // retry cadence and says nothing.
        expect(repairLogs()).toHaveLength(1);

        client.shutdown();
    });

    it('stops supervising once the managed credential is gone', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        client.stopForExpiredCredential();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
        // And it stops calling itself broken. A client that is deliberately
        // finished must go quiet, or its log drowns the machines that are
        // genuinely stuck.
        expect(repairLogs()).toHaveLength(0);
    });

    it('stops supervising after shutdown', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        client.shutdown();

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    it('publishes runtime activity on the encrypted daemon heartbeat', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        client.setRuntimeActivityProvider(() => ({
            activeSessionCount: 2,
            activeAutomationCount: 1,
        }));
        client.connect();

        socketHandlers.connect![0]!();
        await vi.advanceTimersByTimeAsync(20_000);

        expect(machine.daemonState?.activity).toEqual({
            activeSessionCount: 2,
            activeAutomationCount: 1,
            reportedAt: 20_000,
        });
        client.shutdown();
    });

    it.each(['available', 'absent', 'managed'])('publishes daemon session state capability only with a usable reader: %s', async (mode) => {
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        // Stale metadata must be cleared when this process cannot serve the RPC.
        if (mode !== 'available') machine.metadata!.daemonSessionState = { version: 1 };
        const client = new ApiMachineClient('fake-token', machine);
        client.setRPCHandlers({
            spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(),
            portRegistry: {} as any, aiCredentialRuntime: {} as any,
            ...(mode !== 'absent' ? { daemonSessionState: vi.fn() } : {}),
        });
        // The dispatch allowlist is exercised with the real manager in daemonSessionState.test.ts.
        if (mode === 'managed') client.setManagedRuntime({} as any);
        client.connect();
        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.daemonSessionState).toEqual(
            mode === 'available' ? { version: 1 } : undefined,
        ));
        client.shutdown();
    });

    it('publishes autonomous quality-gate capability on the first connection', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            portRegistry: {} as any,
            aiCredentialRuntime: {} as any,
            autonomousQualityGate: {
                start: vi.fn(), status: vi.fn(), control: vi.fn(),
            },
        });
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.autonomousQualityGateSupport).toEqual({
            apiVersion: 1,
            rpcAvailable: true,
        }));

        client.shutdown();
    });

    it('advertises channel support on a machine registered before the advertisement existed', async () => {
        // POST /v1/machines keeps an existing machine's metadata, so the startup metadata that
        // carries `channelSupport` never reaches a machine first registered by an older daemon.
        // Desktop refuses every messenger turn on such a machine as DAEMON_TOO_OLD.
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        expect(machine.metadata?.channelSupport).toBeUndefined();
        const client = new ApiMachineClient('fake-token', machine);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.channelSupport).toEqual(CHANNEL_SUPPORT_CAPABILITY));

        client.shutdown();
    });

    it('advertises AI auth selection on a machine registered before the advertisement existed', async () => {
        // Same registration gap as channel support: without the capability the web UI hides the
        // credential picker and refuses a spawn that carries a selection.
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        expect(machine.metadata?.aiAuthSelection).toBeUndefined();
        const client = new ApiMachineClient('fake-token', machine);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.aiAuthSelection).toEqual(AI_AUTH_SELECTION_CAPABILITY));

        client.shutdown();
    });

    describe('channel host', () => {
        const advertisement = {
            protocolVersion: 1 as const,
            custody: 'available' as const,
            isolation: 'available' as const,
            providers: ['telegram'],
            hostKey: 'host-public-key',
            fingerprint: 'ab:cd',
        };
        const acknowledgeUpdates = () => mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') return { result: 'success', version: 1, metadata: data.metadata };
            if (event === 'machine-update-state') return { result: 'success', version: 1, daemonState: data.daemonState };
            return { result: 'success' };
        });

        it('publishes the host advertisement on the keep-alive and withdraws it when the host goes away', async () => {
            // Startup-only publishing would go stale: the child becomes ready after the machine
            // registered, and it can die at any time after that.
            vi.useFakeTimers();
            acknowledgeUpdates();
            const machine = makeMachine();
            const client = new ApiMachineClient('fake-token', machine);
            client.connect();
            socketHandlers.connect![0]!();
            await vi.waitFor(() => expect(machine.metadata?.channelSupport).toBeDefined());
            expect(machine.metadata?.channelHost).toBeUndefined();

            client.setChannelHostAdvertisement(advertisement);
            await vi.advanceTimersByTimeAsync(20_000);
            await vi.waitFor(() => expect(machine.metadata?.channelHost).toEqual(advertisement));

            client.setChannelHostAdvertisement(undefined);
            await vi.advanceTimersByTimeAsync(20_000);
            await vi.waitFor(() => expect(machine.metadata?.channelHost).toBeUndefined());

            client.shutdown();
        });

        it('clears a stored host advertisement a managed runtime never serves', async () => {
            acknowledgeUpdates();
            const machine = makeMachine();
            machine.metadata = { ...machine.metadata!, channelHost: advertisement };
            const client = new ApiMachineClient('fake-token', machine);
            client.setChannelHostAdvertisement(advertisement);
            client.setRPCHandlers({
                spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(),
                portRegistry: {} as any, aiCredentialRuntime: {} as any,
            });
            client.setManagedRuntime({} as any);
            client.connect();
            socketHandlers.connect![0]!();

            await vi.waitFor(() => expect(machine.metadata?.channelHost).toBeUndefined());
            client.shutdown();
        });

        it('registers channel-host:call only when the daemon runs a host, and hands the params through', async () => {
            const call = vi.fn(async () => ({ wire: { sealed: 'reply' } }));
            const withHost = new ApiMachineClient('fake-token', makeMachine());
            withHost.setRPCHandlers({
                spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(),
                portRegistry: {} as any, aiCredentialRuntime: {} as any,
                channelHostCall: call,
            });
            const registered = vi.mocked((withHost as any).rpcHandlerManager.registerHandler).mock.calls
                .find(([method]: any[]) => method === 'channel-host:call');
            expect(registered).toBeDefined();
            await expect(registered![1]({ wire: { sealed: 'call' } })).resolves.toEqual({ wire: { sealed: 'reply' } });
            expect(call).toHaveBeenCalledWith({ wire: { sealed: 'call' } });

            const withoutHost = new ApiMachineClient('fake-token', makeMachine());
            withoutHost.setRPCHandlers({
                spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(),
                portRegistry: {} as any, aiCredentialRuntime: {} as any,
            });
            expect(vi.mocked((withoutHost as any).rpcHandlerManager.registerHandler).mock.calls
                .some(([method]: any[]) => method === 'channel-host:call')).toBe(false);
        });
    });

    it('does not advertise channel support or AI auth selection from a managed runtime', async () => {
        // A managed runtime serves only `managed:*` RPCs, so the ordinary spawn path those two
        // advertisements promise is refused there; a stored copy is cleared rather than kept.
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        machine.metadata = {
            ...machine.metadata!,
            channelSupport: CHANNEL_SUPPORT_CAPABILITY,
            aiAuthSelection: AI_AUTH_SELECTION_CAPABILITY,
        };
        const client = new ApiMachineClient('fake-token', machine);
        client.setRPCHandlers({
            spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(),
            portRegistry: {} as any, aiCredentialRuntime: {} as any,
        });
        client.setManagedRuntime({} as any);
        client.connect();
        socketHandlers.connect![0]!();

        await vi.waitFor(() => {
            expect(machine.metadata?.channelSupport).toBeUndefined();
            expect(machine.metadata?.aiAuthSelection).toBeUndefined();
        });
        client.shutdown();
    });

    it('starts no second advertisement update while one is still waiting for the server', async () => {
        // The server copy only changes on acknowledgement, so a slow one used to read as stale on
        // every keep-alive and pile up updates, each with its own retry loop.
        vi.useFakeTimers();
        let metadataUpdates = 0;
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                metadataUpdates += 1;
                return new Promise(() => undefined);
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        socketHandlers.connect![0]!();
        await vi.advanceTimersByTimeAsync(0);
        const first = metadataUpdates;
        await vi.advanceTimersByTimeAsync(60_000);

        expect(first).toBeGreaterThan(0);
        expect(metadataUpdates).toBe(first);
        client.shutdown();
    });

    it('starts another advertisement update once the unanswered one has waited past its bound', async () => {
        // A single-flight guard that only an acknowledgement clears would block every capability
        // change forever if that acknowledgement never came.
        vi.useFakeTimers();
        let metadataUpdates = 0;
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                metadataUpdates += 1;
                return new Promise(() => undefined);
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        socketHandlers.connect![0]!();
        await vi.advanceTimersByTimeAsync(0);
        const first = metadataUpdates;
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(metadataUpdates).toBeGreaterThan(first);
        client.shutdown();
    });

    it('clears stale autonomous quality-gate capability when RPC handlers are unavailable', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            if (event === 'machine-update-state') {
                return { result: 'success', version: 1, daemonState: data.daemonState };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        machine.metadata = {
            ...machine.metadata,
            autonomousQualityGateSupport: { apiVersion: 1, rpcAvailable: true },
        };
        const client = new ApiMachineClient('fake-token', machine);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.autonomousQualityGateSupport).toEqual({
            apiVersion: 1,
            rpcAvailable: false,
        }));

        client.shutdown();
    });

    it.each([undefined, 5])('registers the persistent automation key with the verified protocol %s', async (protocolVersion) => {
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'automation-key-register') return { ok: true, value: { keyVersion: 4 } };
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        const persistVersion = vi.fn();
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 3,
        }, persistVersion, protocolVersion);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(persistVersion).toHaveBeenCalledWith(4));
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-key-register', {
            expectedKeyVersion: 3,
            publicKey: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
            protocolVersion: protocolVersion ?? AUTOMATION_PROTOCOL_VERSION,
        });
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('machine-update-metadata', expect.any(Object));
        client.shutdown();
    });

    // Windows 정식 빌드는 세션만 Job 런처로 묶는다. Desktop 이 스크립트·GitHub 트리거를
    // 막을 수 있도록 서버 자동화 광고에 hostCommands:false 를 싣는다.
    it.each([
        { trial: true, expected: false },
        { trial: false, expected: undefined },
    ])('advertises hostCommands=$expected with server-backed automations (trial=$trial)', async ({ trial, expected }) => {
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'automation-key-register') return { ok: true, value: { keyVersion: 4 } };
            if (event === 'machine-update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            return { result: 'success' };
        });
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        if (trial) client.setWindowsStandaloneTrial();
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 3,
        }, vi.fn());
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(machine.metadata?.automationSupport?.serverBacked).toBe(true));
        expect(machine.metadata?.automationSupport?.hostCommands).toBe(expected);
        client.shutdown();
    });

    it('opens the legacy scheduler only after an explicit feature-disabled response', async () => {
        mockSocket.emitWithAck.mockImplementation(async (event: string) => {
            if (event === 'automation-key-register') return { ok: false, error: 'feature-disabled' };
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 0,
        }, vi.fn());
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(client.shouldRunLegacyAutomationScheduler()).toBe(true));
        client.shutdown();
    });

    it('keeps legacy automation fail-closed for transient registration failures', async () => {
        mockSocket.emitWithAck.mockImplementation(async (event: string) => {
            if (event === 'automation-key-register') return { ok: false, error: 'temporary-unavailable' };
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 0,
        }, vi.fn());
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-key-register', expect.any(Object)));
        expect(client.shouldRunLegacyAutomationScheduler()).toBe(false);
        client.shutdown();
    });

    it('syncs encrypted automation deltas after key registration and acknowledges only after cache apply', async () => {
        let cursor = 0n;
        const cache = {
            read: vi.fn(() => ({ cursor, serverTime: 0, automations: [], pendingAcknowledgements: [] })),
            applySync: vi.fn(() => {
                cursor = 1n;
                return { nextSeq: 1n, acknowledgements: [{ automationId: 'automation-1', revision: 1 }] };
            }),
            markAcknowledged: vi.fn(),
        };
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'automation-key-register') return { ok: true, value: { keyVersion: 1 } };
            if (event === 'automation-sync') return { ok: true, value: {
                serverTime: 10, nextSeq: '1', changes: [{ seq: '1' }],
            } };
            if (event === 'automation-sync-ack') return { ok: true, value: { acknowledged: 1 } };
            if (event === 'automation-claim') return { ok: true, value: { runId: 'run-1', claimToken: 'token' } };
            if (event === 'machine-update-metadata') return { result: 'success', version: 1, metadata: data.metadata };
            return { result: 'success' };
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        (client as any).setAutomationKey({
            version: 1,
            publicKey: new Uint8Array(32).fill(7),
            secretKey: new Uint8Array(32).fill(8),
            registeredKeyVersion: 1,
        }, vi.fn());
        (client as any).setServerAutomationCache(cache);
        client.connect();

        socketHandlers.connect![0]!();
        await vi.waitFor(() => expect(cache.markAcknowledged).toHaveBeenCalled());
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-sync', { afterSeq: '0', limit: 500 });
        expect(cache.applySync.mock.invocationCallOrder[0]).toBeLessThan(cache.markAcknowledged.mock.invocationCallOrder[0]!);
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-sync-ack', {
            items: [{ automationId: 'automation-1', revision: 1 }],
        });
        await expect((client as any).serverAutomationTransport().claim({
            automationId: 'automation-1', generation: 2, scheduledFor: 10,
        })).resolves.toEqual({ ok: true, value: { runId: 'run-1', claimToken: 'token' } });
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith('automation-claim', {
            automationId: 'automation-1', generation: 2, scheduledFor: 10,
        });
        client.shutdown();
    });
});

describe('stop-session verifyExit contract', () => {
    const handlers = (overrides: Record<string, unknown> = {}) => ({
        spawnSession: vi.fn(),
        stopSession: vi.fn(() => ({ stopped: true as const })),
        requestShutdown: vi.fn(),
        portRegistry: {} as any,
        aiCredentialRuntime: {} as any,
        ...overrides,
    });

    const stopHandler = (client: ApiMachineClient) => (client as any).rpcHandlerManager
        .registerHandler.mock.calls.find(([method]: [string]) => method === 'stop-session')?.[1];

    it.each(['standalone-unowned', 'standalone-blocked'])('returns an actionable refusal for %s without claiming a stop request', async reason => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers(handlers({ stopSession: vi.fn(() => ({ stopped: false, reason, detail: 'unavailable' })) }) as any);
        const result = await stopHandler(client)({ sessionId: 'session-1' });
        expect(result).toMatchObject({ stopped: false, reason, detail: 'unavailable', error: expect.stringContaining('no') });
        expect(result.message).toBeUndefined();
    });

    it('answers a legacy request exactly as before, with no verification field', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const stopSessionWithExitVerification = vi.fn();
        client.setRPCHandlers(handlers({ stopSessionWithExitVerification }) as any);

        await expect(stopHandler(client)({ sessionId: 'session-1', source: 'project-delete' }))
            .resolves.toEqual({ message: 'Session stopped', stopped: true });
        expect(stopSessionWithExitVerification).not.toHaveBeenCalled();
    });

    it('returns the verified exit alongside the legacy fields for verifyExit: true', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const stopSession = vi.fn(() => ({ stopped: true as const }));
        const stopSessionWithExitVerification = vi.fn(async () => ({
            result: { stopped: true as const },
            exitVerification: {
                status: 'exited' as const,
                scope: 'session-process-tree-snapshot' as const,
                observedProcessCount: 3,
            },
        }));
        client.setRPCHandlers(handlers({ stopSession, stopSessionWithExitVerification }) as any);

        await expect(stopHandler(client)({
            sessionId: 'session-1',
            source: 'project-delete',
            reason: 'deletion',
            mode: 'force',
            verifyExit: true,
        })).resolves.toEqual({
            message: 'Session stopped',
            stopped: true,
            exitVerification: {
                status: 'exited',
                scope: 'session-process-tree-snapshot',
                observedProcessCount: 3,
            },
        });
        expect(stopSessionWithExitVerification).toHaveBeenCalledWith('session-1', {
            source: 'project-delete',
            reason: 'deletion',
            mode: 'force',
        });
        // The verifier owns the stop; the legacy path must not fire a second one.
        expect(stopSession).not.toHaveBeenCalled();
    });

    it('returns an untracked acknowledgement, never an exited claim', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers(handlers({
            stopSessionWithExitVerification: vi.fn(async () => ({
                result: { stopped: false as const, reason: 'not-found' as const },
                exitVerification: {
                    status: 'not-tracked' as const,
                    scope: 'session-process-tree-snapshot' as const,
                    detail: 'session-not-tracked' as const,
                },
            })),
        }) as any);

        await expect(stopHandler(client)({ sessionId: 'session-1', verifyExit: true })).resolves.toEqual({
            message: 'Session not tracked',
            stopped: false,
            reason: 'not-found',
            exitVerification: {
                status: 'not-tracked',
                scope: 'session-process-tree-snapshot',
                detail: 'session-not-tracked',
            },
        });
    });

    it('falls back to the legacy stop marked unavailable when the daemon cannot verify', async () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const stopSession = vi.fn(() => ({ stopped: true as const }));
        client.setRPCHandlers(handlers({ stopSession }) as any);

        await expect(stopHandler(client)({ sessionId: 'session-1', verifyExit: true })).resolves.toEqual({
            message: 'Session stopped',
            stopped: true,
            exitVerification: {
                status: 'unavailable',
                scope: 'session-process-tree-snapshot',
                detail: 'verification-unsupported',
            },
        });
        expect(stopSession).toHaveBeenCalledTimes(1);
    });
});
