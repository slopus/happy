import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { mapCodexMcpMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockVerifySandboxCapability,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
    mockPrepareCodexMultiAuthProxy,
    mockProxyCleanup,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockVerifySandboxCapability: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
    mockPrepareCodexMultiAuthProxy: vi.fn(),
    mockProxyCleanup: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/executionCapability', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sandbox/executionCapability')>()),
    verifySandboxExecutionCapability: mockVerifySandboxCapability,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('./codexMultiAuthProxy', () => ({
    prepareCodexMultiAuthProxy: mockPrepareCodexMultiAuthProxy,
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    exitDelayMs?: number;
    onExit?: () => void;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc: any = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        exitCode: null,
        signalCode: null,
        // A real process exits after SIGTERM; callers wait for that before releasing sandbox
        // resources (bwrap mount points), so the mock must model it.
        kill: vi.fn(() => {
            setTimeout(() => {
                if (proc.exitCode !== null) return;
                proc.exitCode = 0;
                opts?.onExit?.();
                proc.emit('exit', 0, null);
            }, opts?.exitDelayMs ?? 5);
            return true;
        }),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.107.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockVerifySandboxCapability.mockResolvedValue({ ok: true });
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockPrepareCodexMultiAuthProxy.mockResolvedValue(null);
        mockProxyCleanup.mockResolvedValue(undefined);
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
    });

    it('retains host recall ownership on reconnect without mutating the parent environment', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const original = process.env.CLAUDE_MEMORY_RECALL_OWNER;
        delete process.env.CLAUDE_MEMORY_RECALL_OWNER;
        const client = new CodexAppServerClient(sandboxConfig, undefined, undefined, 'owner-choice', undefined, undefined, true);
        try {
            await client.connect();
            expect(mockSpawn.mock.calls[0][2].env.CLAUDE_MEMORY_RECALL_OWNER).toBe('host');
            expect(process.env.CLAUDE_MEMORY_RECALL_OWNER).toBeUndefined();
            await client.disconnect();
            await client.connect();
            expect(mockSpawn.mock.calls[1][2].env.CLAUDE_MEMORY_RECALL_OWNER).toBe('host');
        } finally {
            await client.disconnect();
            if (original === undefined) delete process.env.CLAUDE_MEMORY_RECALL_OWNER;
            else process.env.CLAUDE_MEMORY_RECALL_OWNER = original;
        }
    });

    it('forwards ownership to native MCP at start, resume, fork, and reconnect with the resolved cwd', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, undefined, undefined, 'owner-choice', undefined, undefined, true);
        const native = { alias: { command: 'claude-memory-layer-mcp', enabled: true, env: { KEEP: 'native' } } };
        const runtime = { happy: { command: 'happy-mcp' } };
        await client.connect();
        const request = vi.spyOn(client as any, 'request').mockImplementation(async (method: any) => {
            if (method === 'config/read') return { config: { mcp_servers: native } };
            return { thread: { id: 'thread' }, model: 'test' };
        });
        try {
            await client.startThread({ cwd: '/start', mcpServers: runtime });
            await client.resumeThread({ cwd: '/resume' });
            await client.forkThread({ threadId: 'thread' });
            for (const cwd of ['/start', '/resume']) {
                expect(request).toHaveBeenCalledWith('config/read', { cwd, includeLayers: false }, 3000);
            }
            for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
                expect(request).toHaveBeenCalledWith(method, expect.objectContaining({ config: { mcp_servers: {
                    ...runtime, alias: { ...native.alias, env: { KEEP: 'native', CLAUDE_MEMORY_RECALL_OWNER: 'host' } },
                } } }));
            }
            await client.disconnect();
            // Reconnect uses the real mocked transport for initialize, then the
            // same config discovery path with fresh native configuration.
            request.mockRestore();
            await client.connect();
            const reconnected = vi.spyOn(client as any, 'request').mockImplementation(async (method: any) => {
                if (method === 'config/read') return { config: { mcp_servers: { renamed: native.alias } } };
                return { thread: { id: 'thread' }, model: 'test' };
            });
            await client.resumeThread({ threadId: 'thread', cwd: '/resume', mcpServers: runtime });
            expect(reconnected).toHaveBeenCalledWith('config/read', { cwd: '/resume', includeLayers: false }, 3000);
            expect(reconnected).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
                config: { mcp_servers: { ...runtime, renamed: { ...native.alias, env: { KEEP: 'native', CLAUDE_MEMORY_RECALL_OWNER: 'host' } } } },
            }));
        } finally { await client.disconnect(); }
        expect(native.alias.env).toEqual({ KEEP: 'native' });
        expect(runtime).toEqual({ happy: { command: 'happy-mcp' } });
    });

    it.each([
        [false, 'owner-choice', undefined],
        [true, 'mandatory', undefined],
        [true, 'owner-choice', ['-c', 'managed-provider']],
    ] as const)('leaves native MCP configuration untouched for ineligible hosts', async (prepared, policy, managedArgs) => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, undefined, undefined, policy, managedArgs ? [...managedArgs] : undefined, undefined, prepared);
        const request = vi.spyOn(client as any, 'request').mockResolvedValue({ thread: { id: 'thread' }, model: 'test' });
        await client.startThread({ mcpServers: { memory: { command: 'claude-memory-layer-mcp' } } });
        expect(request).not.toHaveBeenCalledWith('config/read', expect.anything(), expect.anything());
        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ config: { mcp_servers: {
            memory: { command: 'claude-memory-layer-mcp' },
        } } }));
    });

    it('preserves MCP and sandbox configuration if native config discovery fails without logging secrets', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const { logger } = await import('@/ui/logger');
        const client = new CodexAppServerClient(undefined, undefined, undefined, 'owner-choice', undefined, undefined, true);
        const runtime = { happy: { command: 'happy-mcp' } };
        const request = vi.spyOn(client as any, 'request').mockImplementation(async (method: any) => {
            if (method === 'config/read') throw new Error('private config response');
            return { thread: { id: 'thread' }, model: 'test' };
        });
        await client.startThread({ mcpServers: runtime, writableRoots: ['/workspace'] });
        expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ config: {
            mcp_servers: runtime, sandbox_workspace_write: { writable_roots: ['/workspace'] },
        } }));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('direct memory reads may fail'));
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('private config response');
    });

    it('marks memory submission only after turn/start acceptance, preserving pending startup on preparation failure', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const onSubmitted = vi.fn();
        try {
            await client.connect();
            (client as any)._threadId = 'thread';
            await expect(client.sendTurnAndWait('memory context', { onSubmitted, beforeTurn: async () => { throw new Error('preparation failed'); } })).rejects.toThrow('preparation failed');
            expect(onSubmitted).not.toHaveBeenCalled();
            const request = vi.spyOn(client as any, 'request').mockResolvedValue({ turn: { id: 'submitted-turn' } });
            await client.sendTurn('memory context', { onSubmitted });
            expect(request).toHaveBeenCalledWith('turn/start', expect.anything());
            expect(onSubmitted).toHaveBeenCalledOnce();
        } finally { await client.disconnect(); }
    });

    it.each([false, true])('reports only the matching native normal completion to the memory observer (aborted=%s)', async (aborted) => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const onCompleted = vi.fn();
        const send = vi.spyOn(client, 'sendTurn').mockImplementation(async () => {
            const pending = (client as any).pendingTurnCompletion;
            pending.turnId = 'native-completed-turn';
            pending.observation.turnId = 'native-completed-turn';
            expect((client as any).tryResolvePendingTurn(false, 'stale-or-child-turn', 'test')).toBe(false);
            expect(onCompleted).not.toHaveBeenCalled();
            (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: {
                id: 'native-completed-turn', status: aborted ? 'cancelled' : 'completed', error: null,
            } });
        });
        try {
            await client.connect();
            (client as any)._threadId = 'own-thread';
            await expect(client.sendTurnAndWait('completed request', { onCompleted })).resolves.toEqual({ aborted });
            if (aborted) expect(onCompleted).not.toHaveBeenCalled();
            else expect(onCompleted).toHaveBeenCalledWith('native-completed-turn', null);
        } finally { send.mockRestore(); await client.disconnect(); }
    });

    it('ignores completion observer errors and preserves the native result shape', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const send = vi.spyOn(client, 'sendTurn').mockImplementation(async () => {
            (client as any).pendingTurnCompletion.observation.turnId = 'fast-completed-turn';
            (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: { id: 'fast-completed-turn', status: 'completed', error: null } });
        });
        const onCompleted = vi.fn(() => { throw new Error('private observer text'); });
        try {
            await client.connect();
            (client as any)._threadId = 'own-thread';
            await expect(client.sendTurnAndWait('completed request', { onCompleted })).resolves.toEqual({ aborted: false });
            expect(onCompleted).toHaveBeenCalledWith('fast-completed-turn', null);
            const { logger } = await import('@/ui/logger');
            expect(logger.warn).toHaveBeenCalledWith('[CodexAppServer] Completion observer failed');
            expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('private observer text');
        } finally { send.mockRestore(); await client.disconnect(); }
    });

    it('suppresses completed-turn memory when checkpoint apply fails', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const completeTurn = vi.fn(async () => { throw new Error('checkpoint apply failed'); });
        const client = new CodexAppServerClient(undefined, undefined, completeTurn);
        const onCompleted = vi.fn();
        const send = vi.spyOn(client, 'sendTurn').mockImplementation(async () => {
            (client as any).pendingTurnCompletion.observation.turnId = 'completed-before-apply';
            (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: { id: 'completed-before-apply', status: 'completed', error: null } });
        });
        try {
            await client.connect();
            (client as any)._threadId = 'own-thread';
            await expect(client.sendTurnAndWait('apply request', { onCompleted })).rejects.toThrow('checkpoint apply failed');
            expect(onCompleted).not.toHaveBeenCalled();
        } finally { send.mockRestore(); await client.disconnect(); }
    });

    it.each([
        ['failed', null], ['completed', { message: 'private error' }], ['interrupted', null],
    ])('never treats native error/failure as a successful memory completion (status=%s)', async (status, error) => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const onCompleted = vi.fn(); const onSettled = vi.fn();
        const send = vi.spyOn(client, 'sendTurn').mockImplementation(async () => {
            const pending = (client as any).pendingTurnCompletion;
            pending.turnId = 'native-failed-turn'; pending.observation.turnId = 'native-failed-turn';
            (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: { id: 'native-failed-turn', status, error } });
        });
        try {
            await client.connect(); (client as any)._threadId = 'own-thread';
            const result = await client.sendTurnAndWait('native failure', { onCompleted, onCompletionObservationSettled: onSettled });
            expect(result).toEqual({ aborted: status === 'interrupted' });
            expect(onCompleted).not.toHaveBeenCalled(); expect(onSettled).toHaveBeenCalledOnce();
        } finally { send.mockRestore(); await client.disconnect(); }
    });

    it.each(['thread/status/changed:idle', 'item/completed:final_answer'])('preserves synthetic UI completion while waiting for a later authoritative memory completion (%s)', async source => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const onCompleted = vi.fn(); const onSettled = vi.fn();
        const send = vi.spyOn(client, 'sendTurn').mockImplementation(async () => {
            const pending = (client as any).pendingTurnCompletion;
            pending.turnId = 'native-fallback-turn'; pending.observation.turnId = 'native-fallback-turn';
            (client as any).emitRawTurnCompletion('native-fallback-turn', 'completed', null, source);
        });
        try {
            await client.connect(); (client as any)._threadId = 'own-thread';
            await expect(client.sendTurnAndWait('native fallback', { onCompleted, onCompletionObservationSettled: onSettled })).resolves.toEqual({ aborted: false });
            expect(onCompleted).not.toHaveBeenCalled(); expect(onSettled).not.toHaveBeenCalled();
            (client as any).handleNotification('turn/completed', { threadId: 'foreign-thread', turn: { id: 'native-fallback-turn', status: 'completed' } });
            expect(onCompleted).not.toHaveBeenCalled();
            (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: { id: 'native-fallback-turn', status: 'completed' } });
            expect(onCompleted).toHaveBeenCalledWith('native-fallback-turn', null); expect(onSettled).toHaveBeenCalledOnce();
            (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: { id: 'native-fallback-turn', status: 'completed' } });
            expect(onCompleted).toHaveBeenCalledOnce();
        } finally { send.mockRestore(); await client.disconnect(); }
    });

    it('bounds a missing authoritative completion and releases its host continuation', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const onCompleted = vi.fn(); const onSettled = vi.fn();
        const send = vi.spyOn(client, 'sendTurn').mockImplementation(async () => {
            const pending = (client as any).pendingTurnCompletion;
            pending.turnId = 'native-incomplete'; pending.observation.turnId = 'native-incomplete';
            (client as any).emitRawTurnCompletion('native-incomplete', 'completed', null, 'item/completed:final_answer');
        });
        try {
            await client.connect(); (client as any)._threadId = 'own-thread';
            await client.sendTurnAndWait('incomplete fallback', { onCompleted, onCompletionObservationSettled: onSettled });
            await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce(), { timeout: 3_000 });
            expect(onCompleted).not.toHaveBeenCalled();
            expect((client as any).nativeCompletionObservations.size).toBe(0);
        } finally { send.mockRestore(); await client.disconnect(); }
    });

    it('pins memory completion to the accepted turn/start ID rather than an early child lifecycle', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const onCompleted = vi.fn(); const onSettled = vi.fn();
        await client.connect(); (client as any)._threadId = 'own-thread';
        const request = vi.spyOn(client as any, 'request').mockImplementation(async (method: unknown) => {
            if (method === 'turn/start') {
                // Stdio notifications can precede the continuation of the accepted RPC.
                (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: { id: 'child-turn', status: 'completed' } });
                return { turn: { id: 'accepted-native-turn' } };
            }
            return {};
        });
        try {
            await expect(client.sendTurnAndWait('native request', { onCompleted, onCompletionObservationSettled: onSettled })).resolves.toEqual({ aborted: false });
            expect(onCompleted).not.toHaveBeenCalled(); expect(onSettled).not.toHaveBeenCalled();
            (client as any).handleNotification('turn/completed', { threadId: 'own-thread', turn: { id: 'accepted-native-turn', status: 'completed' } });
            expect(onCompleted).toHaveBeenCalledWith('accepted-native-turn', null); expect(onSettled).toHaveBeenCalledOnce();
        } finally { request.mockRestore(); await client.disconnect(); }
    });

    it('uses only matching provider metadata across start, resume, fork and clear', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const request = vi.spyOn(client as any, 'request').mockImplementation(async (method: unknown) => {
            if (method === 'config/read') return { config: {} };
            const name = String(method).split('/')[1];
            return { thread: { id: `thread-${name}`, path: `/tmp/rollout-${name}` }, model: 'test' };
        });
        const send = vi.spyOn(client, 'sendTurn').mockImplementation(async () => {
            (client as any).pendingTurnCompletion.observation.turnId = 'own-completed-turn';
            (client as any).handleNotification('turn/completed', { threadId: client.threadId, turn: { id: 'own-completed-turn', status: 'completed', error: null } });
        });
        try {
            await client.connect();
            await client.startThread({ cwd: '/tmp/project' });
            const startCompleted = vi.fn();
            await client.sendTurnAndWait('start request', { onCompleted: startCompleted });
            expect(startCompleted).toHaveBeenCalledWith('own-completed-turn', { id: 'thread-start', path: '/tmp/rollout-start' });
            await client.resumeThread({ threadId: 'thread-start' });
            const resumeCompleted = vi.fn();
            await client.sendTurnAndWait('resume request', { onCompleted: resumeCompleted });
            expect(resumeCompleted).toHaveBeenCalledWith('own-completed-turn', { id: 'thread-resume', path: '/tmp/rollout-resume' });
            await client.forkThread({ threadId: 'thread-resume' });
            const forkCompleted = vi.fn();
            await client.sendTurnAndWait('fork request', { onCompleted: forkCompleted });
            expect(forkCompleted).toHaveBeenCalledWith('own-completed-turn', { id: 'thread-fork', path: '/tmp/rollout-fork' });
            client.clearThreadState();
            expect((client as any).nativeThreadMetadata).toBeNull();
        } finally { request.mockRestore(); send.mockRestore(); await client.disconnect(); }
    });

    it.each([
        [false, 'owner-choice', undefined],
        [true, 'mandatory', undefined],
        [true, 'owner-choice', ['-c', 'managed-provider']],
    ] as const)('clears inherited ownership for unavailable, shared or managed hosts', async (prepared, policy, managedArgs) => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const original = process.env.CLAUDE_MEMORY_RECALL_OWNER;
        process.env.CLAUDE_MEMORY_RECALL_OWNER = 'host';
        const client = new CodexAppServerClient(sandboxConfig, undefined, undefined, policy, managedArgs ? [...managedArgs] : undefined, undefined, prepared);
        try {
            await client.connect();
            expect(mockSpawn.mock.calls[0][2].env.CLAUDE_MEMORY_RECALL_OWNER).toBeUndefined();
            expect(process.env.CLAUDE_MEMORY_RECALL_OWNER).toBe('host');
        } finally {
            await client.disconnect();
            if (original === undefined) delete process.env.CLAUDE_MEMORY_RECALL_OWNER;
            else process.env.CLAUDE_MEMORY_RECALL_OWNER = original;
        }
    });

    it('marks runtime dispatch once at the actual request, after both checkpoint hooks', async () => {
        const { RuntimeProducerGate } = await import('../sessionDrain/runtimeProducerGate');
        const gate = new RuntimeProducerGate({ hasUndeliveredInput: () => false,
            canFreezeInbound: () => true, freezeInbound: () => true, stopLoop: () => {} });
        gate.beginPreparing(); const observed: unknown[] = [];
        const checkpoint = vi.fn(() => observed.push(gate.blocker()));
        const dispatch = vi.fn(() => gate.markDispatched());
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method !== 'turn/start') return;
            observed.push(gate.blocker());
            setTimeout(() => {
                pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'dispatch-turn' } } });
                pushJsonLine(stdout, { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'dispatch-turn' } } });
                pushJsonLine(stdout, { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'dispatch-turn', status: 'completed' } } });
            }, 0);
        } });
        mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, undefined, undefined, undefined, undefined, checkpoint);
        client.setTurnDispatchHandler(dispatch);
        await client.connect(); (client as any)._threadId = 'thread';
        try {
            await client.sendTurnAndWait('owned prompt');
            expect(checkpoint).toHaveBeenCalledTimes(2);
            expect(dispatch).toHaveBeenCalledOnce();
            expect(observed).toEqual(['turn-preparing', 'turn-preparing', null]);
        } finally { await client.disconnect(); }
    });

    it('rejects a refused runtime dispatch without writing or retaining a pending request', async () => {
        const methods: string[] = [];
        const proc = createMockProcess({ onRequest: msg => { if (msg.method) methods.push(msg.method); } });
        mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setTurnDispatchHandler(() => { throw new Error('runtime claim refused'); });
        await client.connect(); (client as any)._threadId = 'thread';
        try {
            await expect(client.sendTurnAndWait('owned prompt')).rejects.toThrow('runtime claim refused');
            expect(methods).not.toContain('turn/start');
            expect((client as any).pending.size).toBe(0);
            expect((client as any).pendingTurnCompletion).toBeNull();
        } finally { await client.disconnect(); }
    });

    it('holds burst output at the storage gate and drains buffered lines after root exit before reconnect', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: string[] = []; let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const onFailure = vi.fn();
        client.setOutputStorageGate({ wait: async () => { if (events.length === 1) await gate; }, onFailure });
        client.setEventHandler(event => { if (event.type === 'agent_message' && typeof event.message === 'string') events.push(event.message); });
        await client.connect();
        const line = (message: string) => JSON.stringify({ method: 'codex/event', params: { msg: { type: 'agent_message', message } } }) + '\n';
        proc.stdout.push(line('first') + line('second')); proc.stdout.push(null);
        await waitFor(() => events.length > 0);
        expect(events).toEqual(['first']);
        proc.exitCode = 0; proc.emit('exit', 0, null);
        await expect(client.connect()).rejects.toThrow(/output.*drain/i);
        let drained = false; const done = client.waitForOutputDrain().then(() => { drained = true; });
        await new Promise(resolve => setTimeout(resolve, 10)); expect(drained).toBe(false);
        release(); await done; expect(events).toEqual(['first', 'second']);
        expect(onFailure).not.toHaveBeenCalled(); await client.disconnect();
    });

    it('cancels storage-blocked turn admission without sending or restarting the provider', async () => {
        const requests: string[] = [];
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg.method ?? '');
            if (msg.method === 'thread/start') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 't1' } } });
        } });
        mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let blocked = false; let waiting = false;
        client.setOutputStorageGate({ wait: async signal => {
            if (!blocked) return;
            waiting = true;
            await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        }, onFailure: vi.fn() });
        await client.connect(); await client.startThread({ cwd: '/tmp/project' });
        blocked = true;
        const turn = client.sendTurnAndWait('hold this prompt');
        const rejected = expect(turn).rejects.toThrow(/abort/i);
        await waitFor(() => waiting);
        expect(requests).not.toContain('turn/start');
        const result = await client.abortTurnWithFallback();
        expect(result.forcedRestart).toBe(false);
        await rejected;
        expect(proc.kill).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it('reconnects after deliberate output cancellation while retaining incomplete-output evidence', async () => {
        mockSpawn.mockImplementation(() => createMockProcess());
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const onFailure = vi.fn();
        client.setOutputStorageGate({ wait: async () => {}, onFailure });
        await client.connect(); await client.disconnect();
        await client.connect();
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(onFailure).toHaveBeenCalledTimes(1);
        await client.disconnect();
    });

    it('bounds root-exit drain when a descendant retains stdout', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); const onFailure = vi.fn();
        client.setOutputStorageGate({ wait: async () => {}, onFailure });
        await client.connect();
        vi.useFakeTimers();
        try {
            proc.exitCode = 0; proc.emit('exit', 0, null);
            const rejected = expect(client.waitForOutputDrain()).rejects.toThrow(/abort/i);
            await vi.advanceTimersByTimeAsync(5000); await rejected;
            expect(onFailure).toHaveBeenCalledTimes(1);
            await client.disconnect();
        } finally { vi.useRealTimers(); }
    });

    it('drains idle stdout before disconnect without poisoning storage evidence', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); const onFailure = vi.fn();
        client.setOutputStorageGate({ wait: async () => {}, onFailure });
        proc.stdin.once('finish', () => proc.stdout.push(null));
        await client.connect(); await client.disconnect();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('freezes a prepared turn before its late dispatch and refuses reconnect or forceful disconnect', async () => {
        const requests: string[] = [];
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg.method ?? '');
            if (msg.method === 'thread/start') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'freeze-thread' } } });
        } });
        mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        await client.connect(); await client.startThread({ cwd: '/tmp/project' });
        let release!: () => void; let preparing = false;
        const turn = client.sendTurn('late', { beforeTurn: () => { preparing = true; return new Promise<void>(resolve => { release = resolve; }); } });
        const rejected = expect(turn).rejects.toThrow(/frozen/i);
        await waitFor(() => preparing);
        expect(client.freezeInputForShutdown()).toBe(true); release(); await rejected;
        expect(requests).not.toContain('turn/start');
        await expect(client.connect()).rejects.toThrow(/frozen/i);
        await expect(client.disconnect()).rejects.toThrow(/frozen/i);
        expect(proc.kill).not.toHaveBeenCalled();
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        await client.waitForOutputDrain();
    });

    it('joins identical disconnects instead of running cleanup twice', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        await client.connect();
        await Promise.all([client.disconnect(), client.disconnect()]);
        expect(proc.kill).toHaveBeenCalledTimes(1);
    });

    it('coordinates real client EOF, final burst output and storage proof without inventing runtime evidence', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const { SessionDrain } = await import('../sessionDrain/sessionDrain');
        const { SessionStorageBarrier } = await import('../api/sessionStorageBarrier');
        const barrier = new SessionStorageBarrier(); const messages: string[] = [];
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: signal => barrier.waitForCapacity(1, 10, signal), onFailure: () => barrier.fail('unconfirmed-write') });
        client.setEventHandler(event => {
            if (event.type !== 'agent_message') return;
            messages.push(String(event.message)); const confirm = barrier.track(1);
            setTimeout(() => confirm(true), 10);
        });
        await client.connect();
        proc.stdin.once('finish', () => {
            proc.stdout.push(['one', 'two', 'three'].map(message => JSON.stringify({ method: 'codex/event', params: { msg: { type: 'agent_message', message } } })).join('\n') + '\n');
            proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        });
        const coordinator = new SessionDrain('owned-launch', client, {
            tracksShutdownStorage: true,
            flushForShutdown: (ms, signal) => barrier.wait(ms, signal),
            isStorageConfirmationCurrent: proof => barrier.isCurrent(proof),
        }, async () => {});
        const receipt = await coordinator.drain(1000);
        expect(receipt).toMatchObject({ status: 'provider-drained', stored: true, runtimeExited: false, jobEmpty: false });
        expect(messages).toEqual(['one', 'two', 'three']);
        expect(proc.kill).not.toHaveBeenCalled();
        expect(coordinator.isCurrent(receipt)).toBe(true);
        barrier.track()(true); expect(coordinator.isCurrent(receipt)).toBe(false);
        await client.disconnect();
        expect(proc.kill).not.toHaveBeenCalled();
    });

    it('leaves unsupported clients unfrozen so ordinary cleanup remains possible', async () => {
        mockSpawn.mockReturnValue(createMockProcess());
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); await client.connect();
        const cancel = vi.fn(); client.setApprovalHandler(async () => 'denied', cancel);
        expect(client.freezeInputForShutdown()).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        await expect(client.disconnect()).resolves.toBeUndefined();
    });

    it('refuses protected checkpoint sessions before changing admission', async () => {
        mockSpawn.mockReturnValue(createMockProcess());
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() }); await client.connect();
        (client as any).completeTurn = vi.fn();
        expect(client.freezeInputForShutdown()).toBe(false);
        await expect(client.disconnect()).resolves.toBeUndefined();
    });

    it('never forwards a late approval after input freezes', async () => {
        const writes: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: msg => writes.push(msg) }); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); let release!: () => void;
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        client.setApprovalHandler(async () => { await new Promise<void>(resolve => { release = resolve; }); return 'approved'; });
        await client.connect();
        pushJsonLine(proc.stdout, { id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'i', command: 'echo fixture', cwd: '/tmp/project' } });
        await waitFor(() => !!release);
        expect(client.freezeInputForShutdown()).toBe(true); release();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(writes.some(msg => msg.id === 77)).toBe(false);
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        await client.waitForOutputDrain();
    });

    it('waits for approval producer final writes after stdout EOF', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); let release!: () => void;
        let finalWrite = false, drained = false;
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        client.setApprovalHandler(async () => {
            await new Promise<void>(resolve => { release = resolve; });
            finalWrite = true; return 'approved';
        });
        await client.connect();
        pushJsonLine(proc.stdout, { id: 78, method: 'execCommandApproval', params: {} });
        await waitFor(() => !!release);
        expect(client.freezeInputForShutdown()).toBe(true);
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        const drain = client.waitForOutputDrain().then(() => { drained = true; });
        await new Promise(resolve => setTimeout(resolve, 20));
        try { expect(drained).toBe(false); }
        finally { release(); await drain; }
        expect(finalWrite).toBe(true);
    });

    it('cancels existing approvals on freeze and does not admit buffered new approvals', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); let release!: () => void;
        const handler = vi.fn(async () => {
            await new Promise<void>(resolve => { release = resolve; }); return 'abort' as const;
        });
        const cancel = vi.fn(() => release());
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        client.setApprovalHandler(handler, cancel);
        await client.connect();
        pushJsonLine(proc.stdout, { id: 79, method: 'execCommandApproval', params: {} });
        await waitFor(() => !!release);
        expect(client.freezeInputForShutdown()).toBe(true);
        pushJsonLine(proc.stdout, { id: 80, method: 'execCommandApproval', params: {} });
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        await client.waitForOutputDrain();
        expect(cancel).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledOnce();
    });

    it('fails storage observation if approval cancellation throws without reopening input', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); const failed = vi.fn();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: failed });
        client.setApprovalHandler(async () => 'denied', () => { throw new Error('cancel failed'); });
        await client.connect(); expect(client.freezeInputForShutdown()).toBe(true);
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        await expect(client.waitForOutputDrain()).rejects.toThrow('approval');
        expect(failed).toHaveBeenCalledOnce();
        expect(client.freezeInputForShutdown()).toBe(false);
    });

    it('keeps an uncooperative approval producer blocked within the coordinator deadline', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const { SessionDrain } = await import('../sessionDrain/sessionDrain');
        const client = new CodexAppServerClient(); let release!: () => void;
        const failed = vi.fn();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: failed });
        client.setApprovalHandler(async () => {
            await new Promise<void>(resolve => { release = resolve; }); return 'abort';
        });
        await client.connect();
        pushJsonLine(proc.stdout, { id: 81, method: 'execCommandApproval', params: {} });
        await waitFor(() => !!release);
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        const storage = { tracksShutdownStorage: true,
            flushForShutdown: vi.fn(async () => ({ stored: true as const, revision: 1 })),
            isStorageConfirmationCurrent: () => true };
        const coordinator = new SessionDrain('pending-approval', client, storage, async () => {});
        try {
            const receipt = await coordinator.drain(40);
            expect(receipt).toMatchObject({ status: 'blocked', reason: 'deadline', stored: false });
            expect(storage.flushForShutdown).not.toHaveBeenCalled();
            expect(failed).toHaveBeenCalledOnce();
            expect(proc.kill).not.toHaveBeenCalled();
        } finally { release(); await client.waitForOutputDrain(); }
    });

    it('settles the real permission handler cancellation state before output drain completes', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const { CodexPermissionHandler } = await import('./utils/permissionHandler');
        let state: any = {};
        const session = { rpcHandlerManager: { registerHandler: vi.fn() },
            updateAgentState: (update: (value: any) => any) => { state = update(state); } };
        const permissions = new CodexPermissionHandler(session as any);
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        client.setApprovalHandler(async params => (await permissions.handleToolCall(params.callId, 'CodexBash', {})).decision,
            () => permissions.abortAll());
        await client.connect();
        pushJsonLine(proc.stdout, { id: 82, method: 'execCommandApproval', params: { callId: 'pending-real' } });
        await waitFor(() => !!state.requests?.['pending-real']);
        expect(client.freezeInputForShutdown()).toBe(true);
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        await client.waitForOutputDrain();
        expect(state.requests).toEqual({});
        expect(state.completedRequests['pending-real'].status).toBe('canceled');
    });

    it('settles an already-admitted approval that registers only after shutdown freeze', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const { CodexPermissionHandler } = await import('./utils/permissionHandler');
        const session = { rpcHandlerManager: { registerHandler: vi.fn() }, updateAgentState: vi.fn() };
        const permissions = new CodexPermissionHandler(session as any);
        const client = new CodexAppServerClient(); let release!: () => void;
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        client.setApprovalHandler(async params => {
            await new Promise<void>(resolve => { release = resolve; });
            return (await permissions.handleToolCall(params.callId, 'CodexBash', {})).decision;
        }, () => permissions.closeForShutdown());
        await client.connect();
        pushJsonLine(proc.stdout, { id: 84, method: 'execCommandApproval', params: { callId: 'delayed' } });
        await waitFor(() => !!release); expect(client.freezeInputForShutdown()).toBe(true);
        release(); proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        try {
            await client.waitForOutputDrain();
            expect(session.updateAgentState).not.toHaveBeenCalled();
        } finally { permissions.abortAll(); }
    });

    it('observes asynchronous cancellation failures instead of releasing a storage proof', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); const failed = vi.fn();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: failed });
        client.setApprovalHandler(async () => 'denied', async () => { throw new Error('async cancel failed'); });
        await client.connect(); expect(client.freezeInputForShutdown()).toBe(true);
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        await expect(client.waitForOutputDrain()).rejects.toThrow('approval');
        expect(failed).toHaveBeenCalledOnce();
    });

    it('marks storage incomplete when ordinary opt-in disconnect leaves an approval pending', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); const failed = vi.fn(); let release!: () => void;
        client.setOutputStorageGate({ wait: async () => {}, onFailure: failed });
        client.setApprovalHandler(async () => {
            await new Promise<void>(resolve => { release = resolve; }); return 'denied';
        });
        await client.connect();
        pushJsonLine(proc.stdout, { id: 83, method: 'execCommandApproval', params: {} });
        await waitFor(() => !!release);
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        try {
            await client.disconnect();
            expect(failed).toHaveBeenCalledOnce();
            expect(proc.kill).not.toHaveBeenCalled();
        } finally { release(); await client.waitForOutputDrain(); }
    });

    it('marks a never-settling cancellation incomplete at the coordinator deadline', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const { SessionDrain } = await import('../sessionDrain/sessionDrain');
        const client = new CodexAppServerClient(); const failed = vi.fn(); let release!: () => void;
        client.setOutputStorageGate({ wait: async () => {}, onFailure: failed });
        client.setApprovalHandler(async () => 'denied', () => new Promise<void>(resolve => { release = resolve; }));
        await client.connect();
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        const storage = { tracksShutdownStorage: true,
            flushForShutdown: vi.fn(async () => ({ stored: true as const, revision: 1 })),
            isStorageConfirmationCurrent: () => true };
        const coordinator = new SessionDrain('pending-cancellation', client, storage, async () => {});
        try {
            expect(await coordinator.drain(40)).toMatchObject({ status: 'blocked', reason: 'deadline', stored: false });
            expect(failed).toHaveBeenCalledOnce();
            expect(storage.flushForShutdown).not.toHaveBeenCalled();
        } finally { release(); await client.waitForOutputDrain(); }
    });

    it('waits for a conflicting restart disconnect and cancels its later respawn', async () => {
        let turnStarted = false;
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'thread/start') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'stop-thread' } } });
            if (msg.method === 'turn/start') { turnStarted = true; pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'pending-turn' } } }); }
        } }); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        await client.connect(); await client.startThread({ cwd: '/tmp/project' });
        const turn = client.sendTurnAndWait('pending'); await waitFor(() => turnStarted);
        proc.stdin.once('finish', () => proc.stdout.push(null));
        const restart = client.reconnectAndResumeThread({ preservePendingTurnCompletion: true });
        const cancelled = expect(restart).rejects.toThrow(/cancel/i);
        await expect(client.disconnect()).resolves.toBeUndefined(); await cancelled;
        await expect(turn).resolves.toEqual({ aborted: true });
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('runs queued cleanup even when an earlier await-exit disconnect fails', async () => {
        vi.useFakeTimers();
        try {
            const proc = createMockProcess({ exitDelayMs: 60000 }); mockSpawn.mockReturnValue(proc);
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(); const connecting = client.connect();
            await vi.advanceTimersByTimeAsync(50); await connecting;
            const first = (client as any).disconnectInternal({ awaitProcessExit: true });
            const refused = expect(first).rejects.toThrow(/did not exit/);
            const stopped = expect(client.disconnect()).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(6000); await refused; await stopped;
            expect(proc.kill).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });

    it('refuses cleanup during a frozen drain even if the root has already exited', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); let blocked = false; let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        client.setOutputStorageGate({ wait: async () => { if (blocked) await gate; }, onFailure: vi.fn() });
        await client.connect(); expect(client.freezeInputForShutdown()).toBe(true);
        blocked = true; proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        const finished = client.waitForOutputDrain().catch(() => {});
        await expect(client.disconnect()).rejects.toThrow(/frozen/);
        release(); await finished;
    });

    it('refuses freeze during initialize without interrupting that connection', async () => {
        const proc = createMockProcess({ initializeDelayMs: 100 }); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        const connecting = client.connect(); await waitFor(() => mockSpawn.mock.calls.length > 0);
        expect(client.freezeInputForShutdown()).toBe(false);
        await connecting; expect(client.isConnected).toBe(true);
        proc.stdin.once('finish', () => proc.stdout.push(null));
        await client.disconnect();
    });

    it('allows only one shutdown observation owner and cleanup after a blocked dead-root drain', async () => {
        const proc = createMockProcess(); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const { SessionDrain } = await import('../sessionDrain/sessionDrain');
        const client = new CodexAppServerClient();
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() }); await client.connect();
        proc.stdin.once('finish', () => { proc.exitCode = 0; proc.emit('exit', 0, null); });
        const drain = new SessionDrain('dead-root', client, {
            tracksShutdownStorage: true, flushForShutdown: async () => ({ stored: false, reason: 'unsupported' }),
            isStorageConfirmationCurrent: () => false,
        }, async () => {});
        const pending = drain.drain(20);
        expect(client.freezeInputForShutdown()).toBe(false);
        expect((await pending).stored).toBe(false);
        await expect(client.disconnect()).resolves.toBeUndefined();
        expect(proc.kill).not.toHaveBeenCalled();
    });

    it('does not announce or attempt a forced restart when shutdown freezes during abort grace', async () => {
        let interrupted = false; let started = false;
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'thread/start') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'frozen-abort' } } });
            if (msg.method === 'turn/start') { started = true; pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 't' } } }); }
            if (msg.method === 'turn/interrupt') { interrupted = true; pushJsonLine(stdout, { id: msg.id, result: {} }); }
        } }); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); const events: unknown[] = [];
        client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() }); client.setEventHandler(event => events.push(event));
        await client.connect(); await client.startThread({ cwd: '/tmp/project' });
        const turn = client.sendTurnAndWait('wait'); await waitFor(() => started);
        const stopping = client.abortTurnWithFallback({ gracePeriodMs: 50 });
        const result = expect(stopping).resolves.toMatchObject({ forcedRestart: false });
        await waitFor(() => interrupted); expect(client.freezeInputForShutdown()).toBe(true); await result;
        expect(events).not.toContainEqual(expect.objectContaining({ forced_restart: true }));
        proc.stdout.push(null); proc.exitCode = 0; proc.emit('exit', 0, null);
        await client.waitForOutputDrain(); await turn;
    });

    it('preserves a saved thread when a later spawn throws before creating resources', async () => {
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'thread/start') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'saved-thread' } } });
        } }); mockSpawn.mockReturnValue(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(); await client.connect(); await client.startThread({ cwd: '/tmp/project' });
        await (client as any).disconnectInternal({ preserveThreadState: true, awaitProcessExit: true });
        mockSpawn.mockImplementationOnce(() => { throw new Error('synchronous spawn fixture'); });
        await expect(client.connect()).rejects.toThrow('synchronous spawn fixture');
        expect(client.threadId).toBe('saved-thread');
        await client.disconnect(); expect(client.threadId).toBe(null);
    });

    it('reports goal action support for Codex versions with goal action requests', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockExecSync.mockReturnValue('codex-cli 0.140.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(true);

        mockExecSync.mockReturnValue('codex-cli 0.130.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(false);
    });

    it('coalesces raw agent message deltas into a continuous preview before the persisted answer', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (_msg, stdout) => {
                appServerStdout = stdout;
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event));

        await client.connect();
        try {
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            pushJsonLine(appServerStdout, {
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Hel' },
            });
            pushJsonLine(appServerStdout, {
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'lo' },
            });

            await waitFor(() => events.some((event) => event.type === 'agent_message_delta'), 300);
            expect(events.filter((event) => event.type === 'agent_message_delta')).toEqual([{
                type: 'agent_message_delta',
                item_id: 'message-1',
                index: 0,
                offset: 0,
                delta: 'Hello',
                final: false,
            }]);

            pushJsonLine(appServerStdout, {
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '!' },
            });
            pushJsonLine(appServerStdout, {
                method: 'item/completed',
                params: {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    item: { type: 'agentMessage', id: 'message-1', text: 'Hello!', phase: 'final_answer' },
                },
            });

            await waitFor(() => events.some((event) => event.type === 'agent_message'));
            expect(events.filter((event) => event.type === 'agent_message_delta')).toEqual([
                {
                    type: 'agent_message_delta',
                    item_id: 'message-1',
                    index: 0,
                    offset: 0,
                    delta: 'Hello',
                    final: false,
                },
                {
                    type: 'agent_message_delta',
                    item_id: 'message-1',
                    index: 0,
                    offset: 5,
                    delta: '!',
                    final: true,
                },
            ]);
            expect(events.filter((event) => event.type === 'agent_message')).toEqual([
                expect.objectContaining({ message: 'Hello!', item_id: 'message-1' }),
            ]);
        } finally {
            await client.disconnect();
        }
    });

    it('splits an oversized raw agent message delta into bounded continuous frames', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (_msg, stdout) => {
                appServerStdout = stdout;
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event));

        await client.connect();
        try {
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            pushJsonLine(appServerStdout, {
                method: 'item/agentMessage/delta',
                params: {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    itemId: 'message-large',
                    delta: 'a'.repeat(2_050),
                },
            });

            await waitFor(() => events.filter((event) => event.type === 'agent_message_delta').length === 2);
            expect(events.filter((event) => event.type === 'agent_message_delta')).toEqual([
                expect.objectContaining({ item_id: 'message-large', offset: 0, delta: 'a'.repeat(2_048), final: false }),
                expect.objectContaining({ item_id: 'message-large', offset: 2_048, delta: 'aa', final: false }),
            ]);

            pushJsonLine(appServerStdout, {
                method: 'item/completed',
                params: {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    item: { type: 'agentMessage', id: 'message-large', text: 'a'.repeat(2_050), phase: 'final_answer' },
                },
            });
            await waitFor(() => events.filter((event) => event.type === 'agent_message_delta').length === 3);
            expect(events.filter((event) => event.type === 'agent_message_delta').at(-1)).toEqual({
                type: 'agent_message_delta',
                item_id: 'message-large',
                index: 0,
                offset: 2_050,
                delta: '',
                final: true,
            });
        } finally {
            await client.disconnect();
        }
    });

    it('emits response-scoped usage with the native Codex response id', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (_msg, stdout) => {
                appServerStdout = stdout;
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event));

        await client.connect();
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'rawResponse/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                responseId: 'response-1',
                usage: {
                    totalTokens: 150,
                    inputTokens: 120,
                    cachedInputTokens: 70,
                    cacheWriteInputTokens: 10,
                    outputTokens: 30,
                    reasoningOutputTokens: 5,
                },
            },
        });

        await waitFor(() => events.length === 1);
        expect(events[0]).toEqual({
            type: 'codex_usage',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            response_id: 'response-1',
            usage: {
                totalTokens: 150,
                inputTokens: 120,
                cachedInputTokens: 70,
                cacheWriteInputTokens: 10,
                outputTokens: 30,
                reasoningOutputTokens: 5,
            },
        });

        await client.disconnect();
    });

    it('adapts MCP startup notifications and paginated tool/auth inventory', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method !== 'mcpServerStatus/list' || msg.id == null) return;
                requests.push(msg);
                const secondPage = msg.params?.cursor === 'page-2';
                setTimeout(() => pushJsonLine(stdout, {
                    id: msg.id,
                    result: secondPage
                        ? {
                            data: [{ name: 'notion', authStatus: 'notLoggedIn', tools: {} }],
                            nextCursor: null,
                        }
                        : {
                            data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                            nextCursor: 'page-2',
                        },
                }), 0);
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: {
                threadId: 'thread-1',
                name: 'notion',
                status: 'failed',
                error: 'OAuth login required',
                failureReason: 'reauthenticationRequired',
            },
        });
        await waitFor(() => client.getMcpStartupStatuses().length === 1);

        expect(client.getMcpStartupStatuses()).toEqual([{
            threadId: 'thread-1',
            name: 'notion',
            status: 'failed',
            error: 'OAuth login required',
            failureReason: 'reauthenticationRequired',
        }]);
        await expect(client.listMcpServerStatus({ threadId: 'thread-1' })).resolves.toEqual({
            data: [
                { name: 'argos', authStatus: 'unsupported', tools: { search: {} } },
                { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
            ],
            nextCursor: null,
        });
        expect(requests.map(({ params }) => params)).toEqual([
            { threadId: 'thread-1', cursor: null, limit: 100, detail: 'toolsAndAuthOnly' },
            { threadId: 'thread-1', cursor: 'page-2', limit: 100, detail: 'toolsAndAuthOnly' },
        ]);

        client.clearThreadState();
        expect(client.getMcpStartupStatuses()).toEqual([]);

        await client.disconnect();
    });

    it('queries only requested thread servers with scoped pagination', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method !== 'mcpServerStatus/list' || msg.id == null) return;
            requests.push(msg);
            const name = msg.params?.serverName;
            pushJsonLine(stdout, { id: msg.id, result: { data: [{ name, authStatus: 'unsupported', tools: {} }], nextCursor: name === 'one' && !msg.params?.cursor ? 'page-2' : null } });
        } }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        const result = await client.listMcpServerStatus({ threadId: 'thread-1', serverNames: ['one', 'two', 'one'] });
        expect(requests.map(({ params }) => [params?.serverName, params?.cursor])).toEqual([['one', null], ['one', 'page-2'], ['two', null]]);
        expect(result.data.map(entry => entry.name)).toEqual(['one', 'one', 'two']);
        requests.length = 0;
        await expect(client.listMcpServerStatus({ threadId: 'thread-1', serverNames: [] })).resolves.toEqual({ data: [], nextCursor: null });
        expect(requests).toHaveLength(0);
        await client.disconnect();
    });

    it.each([null, 'page-2'])('finishes a scope-ignored inventory when mismatch appears at cursor %s', async mismatchCursor => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method !== 'mcpServerStatus/list' || msg.id == null) return;
            requests.push(msg);
            const cursor = msg.params?.cursor ?? null;
            const names = cursor === mismatchCursor ? ['other'] : cursor === 'page-3' ? ['last'] : ['one'];
            const nextCursor = cursor === null ? 'page-2' : cursor === 'page-2' ? 'page-3' : null;
            pushJsonLine(stdout, { id: msg.id, result: { data: names.map(name => ({ name, authStatus: 'unsupported', tools: {} })), nextCursor } });
        } }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        const result = await client.listMcpServerStatus({ threadId: 'thread-1', serverNames: ['one', 'two', 'three'] });
        expect(result.data.map(entry => entry.name)).toEqual(mismatchCursor === null ? ['other', 'one', 'last'] : ['one', 'other', 'last']);
        expect(requests.map(({ params }) => [params?.serverName, params?.cursor])).toEqual([['one', null], ['one', 'page-2'], ['one', 'page-3']]);
        await client.disconnect();
    });

    it('replaces earlier scoped data with a later scope-ignored complete inventory', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method !== 'mcpServerStatus/list' || msg.id == null) return;
            requests.push(msg);
            const names = msg.params?.serverName === 'one' ? ['one'] : ['one', 'two', 'three'];
            pushJsonLine(stdout, { id: msg.id, result: { data: names.map(name => ({ name, authStatus: 'unsupported', tools: {} })), nextCursor: null } });
        } }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        const result = await client.listMcpServerStatus({ threadId: 'thread-1', serverNames: ['one', 'two', 'three'] });
        expect(result.data.map(entry => entry.name)).toEqual(['one', 'two', 'three']);
        expect(requests.map(({ params }) => params?.serverName)).toEqual(['one', 'two']);
        await client.disconnect();
    });

    it.each(['normal', 'before', 'after', 'twice'])('measures each complete scoped pagination without changing RPCs when observer is %s', async mode => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method !== 'mcpServerStatus/list' || msg.id == null) return;
            requests.push(msg);
            pushJsonLine(stdout, { id: msg.id, result: { data: [{ name: msg.params?.serverName, authStatus: 'unsupported', tools: {} }], nextCursor: msg.params?.serverName === 'one' && !msg.params?.cursor ? 'page-2' : null } });
        } }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();await client.connect();
        let measurements = 0;
        const measureServer = async <T>(action: () => Promise<T>) => {
            measurements++;
            if (mode === 'before') throw Error('observer');
            const result = await action();
            if (mode === 'after') throw Error('observer');
            if (mode === 'twice') await action();
            return result;
        };
        const result = await client.listMcpServerStatus({ threadId: 't', serverNames: ['one', 'two'], measureServer });
        expect(result.data.map(x => x.name)).toEqual(['one', 'one', 'two']);
        expect(requests.map(x => [x.params?.serverName, x.params?.cursor])).toEqual([['one', null], ['one', 'page-2'], ['two', null]]);
        expect(measurements).toBe(2);
        await client.disconnect();
    });

    it('preserves inventory rejection when the observer swallows it', async () => {
        let calls = 0;
        mockSpawn.mockImplementation(() => createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method !== 'mcpServerStatus/list' || msg.id == null) return;
            calls++;pushJsonLine(stdout, { id: msg.id, error: { code: -32000, message: 'inventory failed' } });
        } }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();await client.connect();
        await expect(client.listMcpServerStatus({ threadId: 't', serverNames: ['one'], measureServer: async <T>(action: () => Promise<T>) => { try { return await action(); } catch { return undefined as T; } } })).rejects.toThrow('inventory failed');
        expect(calls).toBe(1);await client.disconnect();
    });

    it('completes MCP runtime recovery before starting the next user turn', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                requests.push(msg);
                if (msg.id == null) return;
                if (msg.method === 'thread/start') {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-1', path: '/tmp/thread-1' }, model: 'gpt-test' },
                    }), 0);
                }
                if (msg.method === 'mcpServerStatus/list') {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                            nextCursor: null,
                        },
                    }), 0);
                }
                if (msg.method === 'thread/resume') {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            method: 'mcpServer/startupStatus/updated',
                            params: { threadId: 'thread-1', name: 'argos', status: 'ready' },
                        });
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-1', path: '/tmp/thread-1' }, model: 'gpt-test' },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/start') {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-1' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-1',
                                turn: { id: 'turn-1', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        }));
        const [{ CodexAppServerClient }, { CodexMcpRuntimeRecovery }] = await Promise.all([
            import('./codexAppServerClient'),
            import('./codexMcpRuntimeRecovery'),
        ]);
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            cwd: '/tmp/project',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            developerInstructions: 'Discover Argos tools before fallback.',
        });
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-1', name: 'argos', status: 'failed' },
        });
        await waitFor(() => client.getMcpStartupStatuses().some(({ status }) => status === 'failed'));

        const recovery = new CodexMcpRuntimeRecovery(client, { maxAttempts: 1, backoffMs: 0 });
        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Discover Argos tools before fallback.',
        })).resolves.toEqual({ status: 'recovered', affectedServers: ['argos'] });
        await expect(client.sendTurnAndWait('Use Argos now.')).resolves.toEqual({ aborted: false });

        const resumeIndex = requests.findIndex(({ method }) => method === 'thread/resume');
        const turnIndex = requests.findIndex(({ method }) => method === 'turn/start');
        expect(resumeIndex).toBeGreaterThan(-1);
        expect(resumeIndex).toBeLessThan(turnIndex);
        expect(requests[resumeIndex]?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            developerInstructions: 'Discover Argos tools before fallback.',
            config: {
                mcp_servers: { argos: { url: 'https://argos.test/mcp' } },
            },
        }));

        await client.disconnect();
    });

    it('persists developer instructions across start, topology-update resume, and fork', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/compact/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                    return;
                }
                if (!['thread/start', 'thread/resume', 'thread/fork'].includes(msg.method ?? '') || msg.id == null) {
                    return;
                }
                const threadId = msg.method === 'thread/fork' ? 'thread-forked' : 'thread-1';
                setTimeout(() => pushJsonLine(stdout, {
                    id: msg.id,
                    result: {
                        thread: { id: threadId, path: `/tmp/${threadId}` },
                        model: 'gpt-test',
                        modelProvider: 'openai',
                        cwd: '/tmp/project',
                        approvalPolicy: 'on-request',
                        sandbox: { type: 'workspaceWrite' },
                        reasoningEffort: null,
                    },
                }), 0);
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await client.startThread({
            cwd: '/tmp/project',
            developerInstructions: 'Discover Gmail tools before browser fallback.',
        });
        await client.resumeThread({
            threadId: 'thread-1',
            developerInstructions: 'Discover Gmail and Argos tools before browser fallback.',
        });
        await client.compactThread({ threadId: 'thread-1' });
        await client.resumeThread({ threadId: 'thread-1' });
        await client.forkThread({ threadId: 'thread-1' });

        expect(requests.find(({ method }) => method === 'thread/start')?.params.developerInstructions)
            .toBe('Discover Gmail tools before browser fallback.');
        expect(requests.filter(({ method }) => method === 'thread/resume').map(({ params }) => (
            params.developerInstructions
        ))).toEqual([
            'Discover Gmail and Argos tools before browser fallback.',
            'Discover Gmail and Argos tools before browser fallback.',
        ]);
        expect(requests.find(({ method }) => method === 'thread/compact/start')?.params).toEqual({
            threadId: 'thread-1',
        });
        expect(requests.find(({ method }) => method === 'thread/fork')?.params.developerInstructions)
            .toBe('Discover Gmail and Argos tools before browser fallback.');

        await client.disconnect();
    });

    it('persists additional writable roots across thread start, resume, and every workspace-write turn', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (['thread/start', 'thread/resume'].includes(msg.method ?? '') && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-roots', path: '/tmp/thread-roots' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-roots' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: { threadId: 'thread-roots', turn: { id: 'turn-roots', status: 'completed' } },
                        });
                    }, 0);
                }
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const writableRoots = ['/repo/frontend', '/repo/backend'];
        await client.connect();

        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write', writableRoots });
        await client.resumeThread({ threadId: 'thread-roots' });
        await client.sendTurnAndWait('edit both projects', { sandbox: 'workspace-write' });

        for (const request of requests.filter(({ method }) => method === 'thread/start' || method === 'thread/resume')) {
            expect(request.params.config).toMatchObject({
                sandbox_workspace_write: { writable_roots: writableRoots },
            });
        }
        expect(requests.find(({ method }) => method === 'turn/start')?.params.sandboxPolicy).toEqual({
            type: 'workspaceWrite',
            writableRoots,
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        });

        await client.disconnect();
    });

    it('does not dispatch a protected turn when the checkpoint gate fails', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-protected', path: '/tmp/thread-protected' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-should-not-start' } },
                    }), 0);
                }
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const beforeTurn = vi.fn(async () => {
            throw new Error('checkpoint unavailable');
        });
        await client.connect();
        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write' });

        await expect(client.sendTurn('edit the project', { beforeTurn }))
            .rejects.toThrow('checkpoint unavailable');

        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(requests.some(({ method }) => method === 'turn/start')).toBe(false);
        await client.disconnect();
    });

    it('does not create a checkpoint when no provider thread can accept the turn', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const beforeTurn = vi.fn(async () => {});

        await expect(client.sendTurnAndWait('edit the project', { beforeTurn }))
            .rejects.toThrow('No active thread');

        expect(beforeTurn).not.toHaveBeenCalled();
    });

    it('runs the checkpoint gate exactly once before dispatching a protected turn', async () => {
        const order: string[] = [];
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-gated', path: '/tmp/thread-gated' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    order.push('provider');
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-gated' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-gated',
                                turn: { id: 'turn-gated', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        }));
        const beforeTurn = vi.fn(async () => {
            order.push('gate');
            return {
                operationId: 'turn-1',
                checkpointId: 'a'.repeat(40),
                providerPath: '/private/checkpoints/codex-turn-1',
            };
        });
        const completeTurn = vi.fn(async (quiesceWriters: () => Promise<void>) => {
            await quiesceWriters();
            order.push('apply');
            return { status: 'completed' as const, entries: [] };
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, beforeTurn, completeTurn);
        await client.connect();
        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write' });

        const onCompleted = vi.fn((turnId, thread) => {
            expect((client as any).connected).toBe(false);
            expect(turnId).toBe('turn-gated');
            expect(thread).toEqual({ id: 'thread-gated', path: '/tmp/thread-gated' });
            order.push('memory');
        });
        await expect(client.sendTurnAndWait('edit the project', { onCompleted }))
            .resolves.toEqual({ aborted: false });

        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(completeTurn).toHaveBeenCalledOnce();
        expect(onCompleted).toHaveBeenCalledOnce();
        expect(order).toEqual(['gate', 'provider', 'apply', 'memory']);
        expect(requests.find(({ method }) => method === 'turn/start')?.params.cwd)
            .toBe('/private/checkpoints/codex-turn-1');
        await client.disconnect();
    });

    it('does not dispatch an excluded-path retry while protection confirmation is pending', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-excluded', path: '/tmp/thread-excluded' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-should-not-start' } },
                    }), 0);
                }
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let rejectConfirmation!: (reason: Error) => void;
        const confirmation = new Promise<void>((_, reject) => {
            rejectConfirmation = reject;
        });
        const beforeTurn = vi.fn(() => confirmation);
        await client.connect();
        await client.startThread({ cwd: '/tmp/project', sandbox: 'workspace-write' });

        const running = client.sendTurnAndWait(
            'retry after the excluded .env write was denied',
            { beforeTurn },
        );
        await vi.waitFor(() => expect(beforeTurn).toHaveBeenCalledOnce());

        expect(requests.some(({ method }) => method === 'turn/start')).toBe(false);

        rejectConfirmation(new Error('excluded path confirmation cancelled'));
        await expect(running).rejects.toThrow('excluded path confirmation cancelled');
        expect(requests.some(({ method }) => method === 'turn/start')).toBe(false);
        await client.disconnect();
    });

    it('clears persisted developer instructions when resume explicitly sends null', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (!['thread/start', 'thread/resume', 'thread/fork'].includes(msg.method ?? '') || msg.id == null) {
                    return;
                }
                const threadId = msg.method === 'thread/fork' ? 'thread-forked' : 'thread-1';
                setTimeout(() => pushJsonLine(stdout, {
                    id: msg.id,
                    result: {
                        thread: { id: threadId, path: `/tmp/${threadId}` },
                        model: 'gpt-test',
                        modelProvider: 'openai',
                        cwd: '/tmp/project',
                        approvalPolicy: 'on-request',
                        sandbox: { type: 'workspaceWrite' },
                        reasoningEffort: null,
                    },
                }), 0);
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        await client.startThread({
            cwd: '/tmp/project',
            developerInstructions: 'SAYCODE INSTRUCTIONS',
        });
        await client.resumeThread({
            threadId: 'thread-1',
            developerInstructions: null,
        });
        await client.resumeThread({ threadId: 'thread-1' });
        await client.forkThread({ threadId: 'thread-1' });

        expect(requests.filter(({ method }) => method === 'thread/resume').map(({ params }) => (
            params.developerInstructions
        ))).toEqual([null, null]);
        expect(requests.find(({ method }) => method === 'thread/fork')?.params.developerInstructions)
            .toBeNull();

        await client.disconnect();
    });

    it.each([
        { platform: 'darwin', inheritedMarker: undefined },
        { platform: 'darwin', inheritedMarker: 'seatbelt' },
        { platform: 'linux', inheritedMarker: undefined },
        { platform: 'linux', inheritedMarker: 'seatbelt' },
    ] as const)('wraps transport with the correct native sandbox marker on $platform (inherited: $inheritedMarker)', async ({ platform, inheritedMarker }) => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const originalMarker = process.env.CODEX_SANDBOX;
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);
        try {
            Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
            if (inheritedMarker === undefined) delete process.env.CODEX_SANDBOX;
            else process.env.CODEX_SANDBOX = inheritedMarker;
            await client.connect();
            expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd(), 'owner-choice');
            expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
            expect(mockSpawn).toHaveBeenCalledWith('sh', ['-c', 'wrapped codex app-server'], expect.anything());
            const env = mockSpawn.mock.calls[0][2].env;
            if (platform === 'darwin') expect(env.CODEX_SANDBOX).toBe('seatbelt');
            else expect(env).not.toHaveProperty('CODEX_SANDBOX');
            expect(env.RUST_LOG).toContain('codex_core::rollout::list=off');
            expect(process.env.CODEX_SANDBOX).toBe(inheritedMarker);
            expect(client.sandboxEnabled).toBe(true);
        } finally {
            await client.disconnect();
            Object.defineProperty(process, 'platform', platformDescriptor);
            if (originalMarker === undefined) delete process.env.CODEX_SANDBOX;
            else process.env.CODEX_SANDBOX = originalMarker;
        }
    });

    // specs/linux-checkpoint-enforcement-backend R4 — bubblewrap binds a mount point for every
    // non-existent deny path the moment the wrapped process starts, so on Linux the turn workspace
    // must be materialized *before* the sandbox is initialized and codex is spawned.
    it('prepares the protected turn workspace before the sandbox wraps and spawns codex', async () => {
        const order: string[] = [];
        mockInitializeSandbox.mockImplementation(async () => {
            order.push('sandbox-init');
            return mockSandboxCleanup;
        });
        mockSpawn.mockImplementation(() => {
            order.push('spawn');
            return createMockProcess({
                onRequest: (msg, stdout) => {
                    if (msg.method === 'thread/start' && msg.id != null) {
                        setTimeout(() => pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-order', path: '/tmp/thread-order' },
                                model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                                approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                            },
                        }), 0);
                    }
                    if (msg.method === 'turn/start' && msg.id != null) {
                        order.push('turn-start');
                        setTimeout(() => {
                            pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-order' } } });
                            pushJsonLine(stdout, {
                                method: 'turn/started',
                                params: { threadId: 'thread-order', turn: { id: 'turn-order', status: 'inProgress' } },
                            });
                            pushJsonLine(stdout, {
                                method: 'turn/completed',
                                params: { threadId: 'thread-order', turn: { id: 'turn-order', status: 'completed', error: null } },
                            });
                        }, 0);
                    }
                },
            });
        });
        const beforeTurn = vi.fn(async () => {
            order.push('before-turn');
            return {
                operationId: 'op-1',
                checkpointId: 'a'.repeat(40),
                providerPath: '/tmp/workspace-order',
            };
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig, beforeTurn);

        const prepared = await client.prepareProtectedTurn();
        expect(prepared?.providerPath).toBe('/tmp/workspace-order');
        await client.connect();
        await client.startThread({ cwd: '/tmp/project' });
        // The real runCodex path is sendTurnAndWait, not sendTurn.
        await expect(client.sendTurnAndWait('edit the project')).resolves.toEqual({ aborted: false });

        // The gate runs once, and it runs before the sandbox is built for the process.
        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(order).toEqual(['before-turn', 'sandbox-init', 'spawn', 'turn-start']);
        order.length = 0;

        // A second protected turn opens its own gate — the consumed preparation is not reused.
        await client.prepareProtectedTurn();
        await client.connect();
        await client.startThread({ cwd: '/tmp/project' });
        await expect(client.sendTurnAndWait('and again')).resolves.toEqual({ aborted: false });
        expect(beforeTurn).toHaveBeenCalledTimes(2);
        expect(order).toEqual(['before-turn', 'sandbox-init', 'spawn', 'turn-start']);
        await client.disconnect();
    });

    it('marks the turn dispatched on the real send paths, before the outcome is known', async () => {
        // The composition only preserves a turn's workspace once it is marked dispatched, so this
        // pins the client-side wiring: reverting the markTurnDispatched() call fails here.
        const marks: string[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-dispatch', path: '/tmp/thread-dispatch' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    marks.push('turn-start');
                    // No completion notification: the turn outcome stays unknown on purpose.
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-dispatch' } } }), 0);
                }
            },
        }));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(
            sandboxConfig,
            async () => {},
            undefined,
            undefined,
            undefined,
            () => marks.push('dispatched'),
        );
        await client.connect();
        await client.startThread({ cwd: '/tmp/project' });

        await client.sendTurn('edit the project');

        // Marked before the provider is even asked to start the turn, and before any outcome.
        expect(marks).toEqual(['dispatched', 'turn-start']);
        await client.disconnect();
    });

    it('refuses to open the gate when the provider process will not exit', async () => {
        // If codex never dies, bwrap still holds its mount points and the sandbox cleanup silently
        // fails, so materializing the workspace would fail later with a confusing error. Fail closed.
        vi.useFakeTimers();
        try {
            const proc = createMockProcess({ exitDelayMs: 60_000 });
            mockSpawn.mockReturnValue(proc);
            const beforeTurn = vi.fn(async () => {});
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig, beforeTurn);
            const connecting = client.connect();
            await vi.advanceTimersByTimeAsync(50);
            await connecting;

            const pending = (client as any).request('test/late-exit', {}, 120_000);
            const rejected = expect(pending).rejects.toThrow(/exited/i);
            const preparing = client.prepareProtectedTurn();
            const assertion = expect(preparing).rejects.toThrow('did not exit');
            await vi.advanceTimersByTimeAsync(10_000);
            await assertion;
            expect(beforeTurn).not.toHaveBeenCalled();

            // A retry must not slip past the check: the old process is still alive and still holds
            // its bwrap mount points, so the gate stays closed until it is really gone.
            const retry = client.prepareProtectedTurn();
            const retryAssertion = expect(retry).rejects.toThrow('did not exit');
            await vi.advanceTimersByTimeAsync(10_000);
            await retryAssertion;
            expect(beforeTurn).not.toHaveBeenCalled();
            proc.exitCode = 0; proc.emit('exit', 0, null);
            await rejected;

        } finally {
            vi.useRealTimers();
        }
    });

    it('disconnects a running codex process before preparing the next protected turn', async () => {
        const order: string[] = [];
        mockSandboxCleanup.mockImplementation(async () => { order.push('sandbox-cleanup'); });
        // bwrap only releases its mount points when the process is gone, so the cleanup that removes
        // them must not run while codex is still alive (spec R4/R7).
        mockSpawn.mockImplementation(() => createMockProcess({
            exitDelayMs: 30,
            onExit: () => order.push('process-exit'),
        }));
        const beforeTurn = vi.fn(async () => {
            order.push('before-turn');
            return { operationId: 'op-2', checkpointId: 'b'.repeat(40), providerPath: '/tmp/workspace-second' };
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig, beforeTurn);
        await client.connect();
        expect(client.isConnected).toBe(true);

        await client.prepareProtectedTurn();

        expect(client.isConnected).toBe(false);
        expect(order).toEqual(['process-exit', 'sandbox-cleanup', 'before-turn']);
    });

    it('runs its protected runtime gate before every turn dispatch', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementation(() => createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-runtime', path: '/tmp/thread-runtime' },
                            model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                            approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-runtime' } },
                    }), 0);
                }
            },
        }));
        const beforeTurn = vi.fn(async () => {});
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig, beforeTurn);
        await client.connect();
        await client.startThread({ cwd: '/tmp/project' });

        await client.sendTurn('edit the project');

        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(requests.some(({ method }) => method === 'turn/start')).toBe(true);
        await client.disconnect();
    });

    // 2026-08-31 회귀 — 8/28 수정이 스폰 시점에 무조건 죽이도록 만들어, 폴백해도
    // 네트워크가 멀쩡한 세션까지 전부 죽였다. connect() 시점에는 permissionMode 를
    // 아직 모른다 (턴마다 결정된다). 그러니 여기서는 초기화 실패 사실만 기록하고,
    // 네트워크를 실제로 잃는지는 모드를 아는 턴 시점에서 판정한다.
    it('records sandbox init failure and still connects — the turn decides if it is fatal', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(client.sandboxEnabled).toBe(false);
        expect(client.sandboxInitFailed).toBe(true);
        expect(mockSpawn).toHaveBeenCalled();

        await client.disconnect();
    });


    // local 경로와 같은 확인이다: 초기화 성공은 격리 성공의 증거가 아니다.
    it('refuses to connect on a mandatory machine when the sandbox cannot execute', async () => {
        mockVerifySandboxCapability.mockResolvedValue({
            ok: false,
            reason: 'namespace-denied',
            detail: 'bwrap: Creating new namespace failed: Operation not permitted',
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig, undefined, undefined, 'mandatory');

        await expect(client.connect()).rejects.toThrow(/capability-unavailable/);

        expect(mockSpawn).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it('does not probe sandbox capability on an owner-choice machine', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockVerifySandboxCapability).not.toHaveBeenCalled();
        await client.disconnect();
    });

    // 위 완화는 개인 머신 이야기다. mandatory 머신에서 폴백하면 네이티브 정책이
    // workspace-write/danger-full-access 가 되어 호스트 전체가 열린다 — 턴을
    // 기다리지 않고 connect 에서 멈춘다.
    it('refuses to connect on a mandatory machine when sandbox init fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('bwrap unavailable'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig, undefined, undefined, 'mandatory');

        await expect(client.connect()).rejects.toThrow(/init-failed/);

        expect(mockSpawn).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it('leaves sandboxInitFailed false when the sandbox initialised cleanly', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(client.sandboxEnabled).toBe(true);
        expect(client.sandboxInitFailed).toBe(false);

        await client.disconnect();
    });

    it('still falls back to non-sandbox transport when the sandbox deliberately blocks network', async () => {
        // 네트워크를 원래도 안 쓰려던 자리는 초기화가 실패해도 계속 진행해도 된다 —
        // Codex 네이티브 readOnly 정책도 어차피 네트워크가 없으므로 의도와 일치한다.
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient({ ...sandboxConfig, networkMode: 'blocked' });

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('fails closed when a protected runtime cannot initialize its sandbox', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(
            { ...sandboxConfig, networkMode: 'blocked' },
            vi.fn(async () => {}),
        );

        await expect(client.connect()).rejects.toThrow(/checkpoint protection sandbox initialization failed/);

        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('routes managed Codex sessions through multi-auth and closes the proxy on disconnect', async () => {
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: ['-c', 'model_provider="codex-multi-auth-runtime-proxy"'],
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'local-client-key' },
            cleanup: mockProxyCleanup,
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://', '-c', 'model_provider="codex-multi-auth-runtime-proxy"'],
            expect.objectContaining({
                env: expect.objectContaining({ OPENAI_API_KEY: 'local-client-key' }),
            }),
        );
        await client.disconnect();
        expect(mockProxyCleanup).toHaveBeenCalledOnce();
    });

    it('closes the multi-auth proxy when the Codex process exits unexpectedly', async () => {
        const proc = createMockProcess();
        mockSpawn.mockImplementation(() => proc);
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: [],
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'local-client-key' },
            cleanup: mockProxyCleanup,
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        proc.emit('exit', 1, null);

        await waitFor(() => mockProxyCleanup.mock.calls.length === 1);
        await client.disconnect();
        expect(mockProxyCleanup).toHaveBeenCalledOnce();
    });

    it('closes the multi-auth proxy when spawning Codex throws synchronously', async () => {
        mockSpawn.mockImplementation(() => {
            throw new Error('spawn failed');
        });
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: [],
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'local-client-key' },
            cleanup: mockProxyCleanup,
        });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await expect(client.connect()).rejects.toThrow('spawn failed');
        expect(mockProxyCleanup).toHaveBeenCalledOnce();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            reason: 'interrupted',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it.each([false, true, 'eof'])('keeps a queued turn behind thread resume during a forced restart (storage gate=%s)', async (tracked) => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        let resumeCompleted = false;

        const proc1 = createMockProcess({
            pid: 2011,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-restart-order', path: '/tmp/thread-restart-order' } },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-before-restart' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-restart-order',
                                turn: { id: 'turn-before-restart', status: 'inProgress' },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });

        if (tracked === 'eof') proc1.stdin.once('finish', () => {
            pushJsonLine(proc1.stdout, { method: 'turn/completed', params: {
                threadId: 'thread-restart-order', turn: { id: 'turn-before-restart', status: 'completed', error: null },
            } });
            proc1.stdout.push(null);
        });

        const proc2 = createMockProcess({
            pid: 2012,
            initializeDelayMs: 30,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        resumeCompleted = true;
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-restart-order', path: '/tmp/thread-restart-order' } },
                        });
                    }, 30);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-after-resume' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-restart-order',
                                turn: { id: 'turn-after-resume', status: 'inProgress' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-restart-order',
                                turn: { id: 'turn-after-resume', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        if (tracked) client.setOutputStorageGate({ wait: async () => {}, onFailure: vi.fn() });
        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const interruptedTurn = client.sendTurnAndWait('hang before restart', { turnTimeoutMs: 60_000 });
        const queuedTurn = interruptedTurn.then(() => client.sendTurnAndWait('queued during restart'));
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const restart = client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });
        await waitFor(() => secondProcessRequests.some((msg) => msg.method === 'turn/start'), 4000);

        expect(resumeCompleted).toBe(true);
        expect(secondProcessRequests.findIndex((msg) => msg.method === 'thread/resume')).toBeLessThan(
            secondProcessRequests.findIndex((msg) => msg.method === 'turn/start'),
        );
        await expect(restart).resolves.toEqual(expect.objectContaining({
            forcedRestart: true,
            resumedThread: true,
        }));
        await expect(interruptedTurn).resolves.toEqual({ aborted: true });
        await expect(queuedTurn).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('does not dispatch a queued turn when forced restart cannot resume the thread', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        const proc1 = createMockProcess({
            pid: 2013,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-resume-failure', path: '/tmp/thread-resume-failure' } },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-resume-failure' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-resume-failure',
                                turn: { id: 'turn-resume-failure', status: 'inProgress' },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        const proc2 = createMockProcess({
            pid: 2014,
            initializeDelayMs: 20,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        error: { code: -32600, message: 'thread not found' },
                    }), 20);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const interruptedTurn = client.sendTurnAndWait('hang before failed resume', { turnTimeoutMs: 60_000 });
        const queuedTurn = interruptedTurn.then(() => client.sendTurnAndWait('must not dispatch'));
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        await expect(client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        })).resolves.toEqual(expect.objectContaining({
            forcedRestart: true,
            resumedThread: false,
        }));
        await expect(interruptedTurn).resolves.toEqual({ aborted: true });
        await expect(queuedTurn).rejects.toThrow('No active thread');
        expect(secondProcessRequests.some((msg) => msg.method === 'turn/start')).toBe(false);

        await client.disconnect();
    });

    it('keeps an active turn alive when provider progress resets the inactivity timeout', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2003,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-timeout', path: '/tmp/thread-timeout' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-timeout', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-timeout',
                                turn: { id: 'turn-timeout', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('long active turn', { turnTimeoutMs: 200 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await vi.advanceTimersByTimeAsync(120);
            pushJsonLine(appServerStdout, {
                method: 'item/started',
                params: {
                    threadId: 'thread-timeout',
                    turnId: 'turn-timeout',
                    item: { id: 'item-progress', type: 'agentMessage', text: '', phase: 'commentary' },
                },
            });
            await vi.advanceTimersByTimeAsync(120);
            pushJsonLine(appServerStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-timeout',
                    turn: { id: 'turn-timeout', items: [], status: 'completed', error: null },
                },
            });

            await expect(pending).resolves.toEqual({ aborted: false });
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);
            expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('ignores stale-turn activity and interrupts the inactive current provider turn', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2004,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-inactive', path: '/tmp/thread-inactive' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-inactive', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-inactive',
                                turn: { id: 'turn-inactive', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-inactive',
                                turn: { id: 'turn-inactive', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await vi.advanceTimersByTimeAsync(15);
            pushJsonLine(appServerStdout, {
                method: 'item/started',
                params: {
                    threadId: 'thread-inactive',
                    turnId: 'turn-from-previous-request',
                    item: { id: 'stale-item', type: 'agentMessage', text: '', phase: 'commentary' },
                },
            });
            await vi.advanceTimersByTimeAsync(6);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            expect(events.filter((event) => event.type === 'turn_aborted')).toEqual([
                expect.objectContaining({ turn_id: 'turn-inactive', status: 'cancelled' }),
            ]);
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags a watchdog-forced abort with the inactivity reason and the not-ready MCP servers', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2014,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-hung', path: '/tmp/thread-hung' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-hung', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-hung',
                                turn: { id: 'turn-hung', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-hung',
                                turn: { id: 'turn-hung', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        // One server never finished starting; another is fine. Only the hung one
        // should be surfaced to the user.
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-hung', name: 'aplus-common', status: 'ready' },
        });
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-hung', name: 'dataAnalyticsWidgets', status: 'starting' },
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            // Provider goes fully silent — the watchdog must fire.
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).toMatchObject({
                turn_id: 'turn-hung',
                reason: 'inactivity_timeout',
                not_ready_mcp_servers: ['dataAnalyticsWidgets'],
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags the completion with the inactivity reason even when codex settles the interrupted turn as completed', async () => {
        // Replays the real incident: codex answered the watchdog's turn/interrupt
        // with turn/completed status 'completed' (not 'cancelled'), so the abort
        // surfaced as task_complete and the user saw nothing.
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2015,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-done', path: '/tmp/thread-done' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-done', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-done',
                                turn: { id: 'turn-done', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-done',
                                turn: { id: 'turn-done', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: false });
            const terminalEvents = events.filter((event) =>
                event.type === 'task_complete' || event.type === 'turn_aborted');
            expect(terminalEvents).toHaveLength(1);
            expect(terminalEvents[0]).toMatchObject({
                type: 'task_complete',
                turn_id: 'turn-done',
                reason: 'inactivity_timeout',
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('does not tag a user-initiated abort as inactivity even when the watchdog deadline passes mid-abort', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2016,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-cancel', path: '/tmp/thread-cancel' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-cancel', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-cancel',
                                turn: { id: 'turn-cancel', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    // The provider takes 30ms to honor the user's interrupt — long
                    // enough for the 20ms inactivity deadline to pass mid-abort.
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-cancel',
                                turn: { id: 'turn-cancel', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 30);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(10);
            // User cancels before the watchdog deadline.
            const abortPromise = client.abortTurnWithFallback({ gracePeriodMs: 100 });
            await vi.advanceTimersByTimeAsync(40);

            await expect(abortPromise).resolves.toMatchObject({ aborted: true });
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).not.toHaveProperty('reason', 'inactivity_timeout');
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags a watchdog abort delivered via the legacy codex/event protocol', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2017,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-legacy', path: '/tmp/thread-legacy' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-legacy', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-legacy' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'turn_aborted', turn_id: 'turn-legacy' } },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-legacy', name: 'dataAnalyticsWidgets', status: 'starting' },
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).toMatchObject({
                reason: 'inactivity_timeout',
                not_ready_mcp_servers: ['dataAnalyticsWidgets'],
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('keeps an active turn alive while an approval request awaits the user', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2005,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-approval', path: '/tmp/thread-approval' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-approval', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-approval',
                                turn: { id: 'turn-approval', items: [], status: 'inProgress', error: null },
                            },
                        });
                        // Codex asks the user to approve a command and then goes
                        // silent until we answer — no turn notifications arrive.
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-approval',
                                turnId: 'turn-approval',
                                itemId: 'exec-approval-1',
                                command: 'rm -rf build',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        // Held by the approval handler so the test controls when the user answers.
        let approveUser: () => void = () => { throw new Error('approval not requested yet'); };
        const approvalRequested = new Promise<void>((resolveRequested) => {
            client.setApprovalHandler(async () => {
                await new Promise<void>((resolveDecision) => {
                    approveUser = resolveDecision;
                    resolveRequested();
                });
                return 'approved';
            });
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('needs approval', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await approvalRequested;

            // The provider is blocked on us, not hung — the watchdog must not fire
            // no matter how long the user takes to answer.
            await vi.advanceTimersByTimeAsync(500);
            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);

            approveUser();
            await vi.advanceTimersByTimeAsync(0);
            pushJsonLine(appServerStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-approval',
                    turn: { id: 'turn-approval', items: [], status: 'completed', error: null },
                },
            });

            await expect(pending).resolves.toEqual({ aborted: false });
            expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('resumes the inactivity watchdog after an approval is answered', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2006,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-after-approval', path: '/tmp/thread-after-approval' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-after-approval', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-after-approval',
                                turn: { id: 'turn-after-approval', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 78,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-after-approval',
                                turnId: 'turn-after-approval',
                                itemId: 'exec-approval-2',
                                command: 'sleep 600',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-after-approval',
                                turn: { id: 'turn-after-approval', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        const approvalRequested = new Promise<void>((resolveRequested) => {
            client.setApprovalHandler(async () => {
                resolveRequested();
                return 'approved';
            });
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('approve then hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await approvalRequested;
            await vi.advanceTimersByTimeAsync(0);

            // Approval answered and the provider still goes silent — the watchdog
            // must re-arm and interrupt the genuinely stuck turn.
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('ignores an approval completion from a disconnected app-server epoch', async () => {
        const secondProcessRequests: MockRpcMessage[] = [];
        let secondStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;

        const proc1 = createMockProcess({
            pid: 2007,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-epoch', path: '/tmp/thread-epoch' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-old', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-epoch',
                                turn: { id: 'turn-old', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-epoch',
                                turnId: 'turn-old',
                                itemId: 'old-approval',
                                command: 'old command',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2008,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                secondStdout = stdout;
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-epoch', path: '/tmp/thread-epoch' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-new', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-epoch',
                                turn: { id: 'turn-new', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 88,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-epoch',
                                turnId: 'turn-new',
                                itemId: 'new-approval',
                                command: 'new command',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let releaseOldApproval!: () => void;
        let releaseNewApproval!: () => void;
        let markOldApprovalRequested!: () => void;
        let markNewApprovalRequested!: () => void;
        const oldApprovalDecision = new Promise<void>((resolve) => { releaseOldApproval = resolve; });
        const newApprovalDecision = new Promise<void>((resolve) => { releaseNewApproval = resolve; });
        const oldApprovalRequested = new Promise<void>((resolve) => { markOldApprovalRequested = resolve; });
        const newApprovalRequested = new Promise<void>((resolve) => { markNewApprovalRequested = resolve; });
        client.setApprovalHandler(async ({ callId }) => {
            if (callId === 'old-approval') {
                markOldApprovalRequested();
                await oldApprovalDecision;
                return 'approved';
            }
            markNewApprovalRequested();
            await newApprovalDecision;
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        const oldPending = client.sendTurnAndWait('old turn', { turnTimeoutMs: 60_000 });
        await oldApprovalRequested;
        await expect(client.reconnectAndResumeThread()).resolves.toBe(true);
        await expect(oldPending).resolves.toEqual({ aborted: true });

        vi.useFakeTimers();
        try {
            const newPending = client.sendTurnAndWait('new turn', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await newApprovalRequested;

            releaseOldApproval();
            await vi.advanceTimersByTimeAsync(0);

            expect(secondProcessRequests.some((request) => request.id === 77 && request.result !== undefined)).toBe(false);
            await vi.advanceTimersByTimeAsync(25);
            expect(secondProcessRequests.some((request) => request.method === 'turn/interrupt')).toBe(false);

            releaseNewApproval();
            await vi.advanceTimersByTimeAsync(0);
            if (!secondStdout) throw new Error('second app-server stdout unavailable');
            pushJsonLine(secondStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-epoch',
                    turn: { id: 'turn-new', items: [], status: 'completed', error: null },
                },
            });
            await expect(newPending).resolves.toEqual({ aborted: false });
        } finally {
            releaseOldApproval();
            releaseNewApproval();
            await vi.advanceTimersByTimeAsync(0);
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('re-arms the watchdog for a turn started after a crash left an approval outstanding', async () => {
        const secondProcessRequests: MockRpcMessage[] = [];
        const proc1 = createMockProcess({
            pid: 2009,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-crash', path: '/tmp/thread-crash' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-crash', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-crash',
                                turnId: 'turn-crash',
                                itemId: 'crash-approval',
                                command: 'never answered',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2010,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-after-crash', items: [], status: 'inProgress', error: null } },
                    }), 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-crash',
                                turn: { id: 'turn-after-crash', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let releaseApproval!: () => void;
        let markApprovalRequested!: () => void;
        const approvalDecision = new Promise<void>((resolve) => { releaseApproval = resolve; });
        const approvalRequested = new Promise<void>((resolve) => { markApprovalRequested = resolve; });
        client.setApprovalHandler(async () => {
            markApprovalRequested();
            await approvalDecision;
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        const crashedTurn = client.sendTurnAndWait('crashes mid-approval', { turnTimeoutMs: 60_000 });
        await approvalRequested;

        // The app-server dies while the approval is still outstanding, so
        // disconnectInternal never runs to clear the outstanding-request count.
        proc1.emit('exit', 1, null);
        await expect(crashedTurn).resolves.toEqual({ aborted: true });
        await client.connect();

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('after crash', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(secondProcessRequests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
        } finally {
            releaseApproval();
            await vi.advanceTimersByTimeAsync(0);
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('forks, reads, and rolls back Codex threads through app-server RPC', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2501,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    path: '/tmp/thread-forked',
                                    forkedFromId: 'thread-source',
                                    turns: [],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/rollback' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/inject_items' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {},
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        const forked = await client.forkThread({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        const imported = await client.forkThreadFromPath({
            path: '/tmp/imported-rollout.jsonl',
            cwd: '/tmp/moved-project',
        });
        const read = await client.readThread({ threadId: forked.threadId, includeTurns: true });
        const rolledBack = await client.rollbackThread({ threadId: forked.threadId, numTurns: 2 });
        const injected = await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        expect(forked.threadId).toBe('thread-forked');
        expect(imported.threadId).toBe('thread-forked');
        expect(read.thread.turns).toHaveLength(1);
        expect(rolledBack.thread.turns).toHaveLength(1);
        expect(injected).toEqual({});
        expect(requests.find((msg) => msg.method === 'thread/fork')?.params).toEqual(expect.objectContaining({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        expect(requests.find((msg) => (
            msg.method === 'thread/fork'
            && (msg.params as { path?: string } | undefined)?.path === '/tmp/imported-rollout.jsonl'
        ))?.params).toEqual(expect.objectContaining({
            threadId: '',
            path: '/tmp/imported-rollout.jsonl',
            cwd: '/tmp/moved-project',
        }));
        expect(requests.find((msg) => msg.method === 'thread/read')?.params).toEqual({
            threadId: 'thread-forked',
            includeTurns: true,
        });
        expect(requests.find((msg) => msg.method === 'thread/rollback')?.params).toEqual({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(requests.find((msg) => msg.method === 'thread/inject_items')?.params).toEqual({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        await client.disconnect();
    });

    it('clears active thread state so the next prompt starts a fresh thread', async () => {
        const requests: MockRpcMessage[] = [];
        let nextThreadNumber = 1;
        const proc = createMockProcess({
            pid: 2601,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = `thread-${nextThreadNumber++}`;
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: threadId, path: `/tmp/${threadId}` },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-1');
        expect(client.hasActiveThread()).toBe(true);

        client.clearThreadState();

        expect(client.threadId).toBeNull();
        expect(client.turnId).toBeNull();
        expect(client.hasActiveThread()).toBe(false);

        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-2');
        expect(requests.filter((msg) => msg.method === 'thread/start')).toHaveLength(2);

        await client.disconnect();
    });

    it('sends extra localImage input items and omits empty text for image-only turns', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2801,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-images', path: '/tmp/thread-images' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-images',
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('', {
            extraInputItems: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-images',
            input: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        await client.disconnect();
    });

    it('keeps text-only turn input unchanged when no extra input items are supplied', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2802,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-text', path: '/tmp/thread-text' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-text',
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('hello');

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-text',
            input: [{ type: 'text', text: 'hello' }],
        });

        await client.disconnect();
    });

    it('steers text into the currently active Codex turn', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2803,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-steer', path: '/tmp/thread-steer' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            turn: { id: 'turn-steer', items: [], status: 'inProgress', error: null },
                        },
                    }), 0);
                }

                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurn('initial request');
        await client.steerTurn('apply this now');

        expect(requests.find((msg) => msg.method === 'turn/steer')?.params).toEqual({
            threadId: 'thread-steer',
            input: [{ type: 'text', text: 'apply this now' }],
            expectedTurnId: 'turn-steer',
        });

        await client.disconnect();
    });

    it('waits for authoritative completion after steering adds more work to the turn', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2804,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-steered-completion', path: '/tmp/thread-steered-completion' },
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-steered-completion', status: 'inProgress' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-steered-completion',
                                turn: { id: 'turn-steered-completion', status: 'inProgress' },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/steer' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const completion = client.sendTurnAndWait('initial request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started'));
        await client.steerTurn('additional request');
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-steered-completion',
                turnId: 'turn-steered-completion',
                item: {
                    type: 'agentMessage',
                    id: 'msg-intermediate-final',
                    text: 'first answer before steered work finishes',
                    phase: 'final_answer',
                },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-steered-completion',
                turn: { id: 'turn-steered-completion', status: 'completed', error: null },
            },
        });

        await expect(completion).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('rejects steering when Codex has no active turn', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await expect(client.steerTurn('too late')).rejects.toThrow('No active Codex turn');
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'call-1', output: '/tmp/project\n' }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    // desktop-stuck-responding-state: a mid-turn agentMessage can legitimately
    // carry phase 'final_answer' (Codex asking a clarifying question), which
    // schedules our idle-fallback task_complete. When Codex then resumes the
    // SAME provider turn — no fresh turn/started, since it never asked for a
    // new turn — the authoritative turn/completed that eventually arrives for
    // that turnId must not be dropped as a duplicate of the premature one, or
    // the session never gets a real terminal marker again.
    it('does not drop the authoritative completion when work resumes after a premature final_answer fallback', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3010,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-resume', path: '/tmp/thread-resume' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-resume-1', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-resume', turn: { id: 'turn-resume-1' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-resume',
                                turnId: 'turn-resume-1',
                                item: { type: 'agentMessage', id: 'msg-mid-turn', text: 'clarifying question', phase: 'final_answer' },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access' });

        // The premature fallback resolves sendTurnAndWait ~250ms after the
        // final_answer-phase message, with no open command to defer behind.
        await expect(client.sendTurnAndWait('initial request')).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        // Codex keeps working on the SAME provider turn: no turn/started
        // precedes this activity, matching the production log
        // (~/.happy_remote/logs — exec_command_begin ~23s after task_complete
        // with no intervening task_started).
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'item/started',
            params: {
                threadId: 'thread-resume',
                turnId: 'turn-resume-1',
                item: { type: 'commandExecution', id: 'call-resume', command: 'cat file', cwd: '/tmp', status: 'inProgress' },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-resume',
                turnId: 'turn-resume-1',
                item: {
                    type: 'commandExecution', id: 'call-resume', command: 'cat file', cwd: '/tmp',
                    aggregatedOutput: 'contents', exitCode: 0, durationMs: 1, status: 'completed',
                },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-resume',
                turnId: 'turn-resume-1',
                item: { type: 'agentMessage', id: 'msg-real-final', text: 'the real final answer', phase: 'final_answer' },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: { threadId: 'thread-resume', turn: { id: 'turn-resume-1', status: 'completed', error: null } },
        });

        await waitFor(() => events.filter((event) => event.type === 'task_complete').length >= 2);
        expect(events.filter((event) => event.type === 'exec_command_end')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'agent_message' && event.message === 'the real final answer')).toHaveLength(1);

        let mapperState = {
            currentTurnId: null as string | null,
            currentProviderTurnId: null as string | null,
        };
        const lifecycleTypes = events.flatMap((event) => {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, mapperState);
            mapperState = mapped;
            return mapped.envelopes.map((envelope) => envelope.ev.t);
        }).filter((type) => type === 'turn-start' || type === 'turn-end');
        expect(lifecycleTypes).toEqual([
            'turn-start',
            'turn-end',
            'turn-start',
            'turn-end',
        ]);

        await client.disconnect();
    });

    it('defers terminal completion until a command started by the turn completes', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { thread: { id: 'thread-delayed-command', path: '/tmp/thread-delayed-command' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-delayed-command' } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: { threadId: 'thread-delayed-command', turn: { id: 'turn-delayed-command' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-delayed-command',
                                turnId: 'turn-delayed-command',
                                item: {
                                    type: 'commandExecution', id: 'call-delayed', command: 'sleep 1', cwd: '/tmp', status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-delayed-command',
                                turnId: 'turn-delayed-command',
                                item: { type: 'agentMessage', id: 'final-delayed', text: 'final answer', phase: 'final_answer' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-delayed-command', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-delayed-command',
                                turn: { id: 'turn-delayed-command', status: 'failed', error: 'provider failed' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-delayed-command',
                                turn: { id: 'turn-stale', status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' });

        let settled = false;
        const completion = client.sendTurnAndWait('run delayed command').then((result) => {
            settled = true;
            return result;
        });
        await waitFor(() => events.some((event) => event.type === 'exec_command_begin'));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(events.some((event) => event.type === 'task_complete')).toBe(false);
        expect(settled).toBe(false);

        pushJsonLine(appServerStdout!, {
            method: 'item/completed',
            params: {
                threadId: 'thread-delayed-command',
                turnId: 'turn-delayed-command',
                item: {
                    type: 'commandExecution', id: 'call-delayed', command: 'sleep 1', cwd: '/tmp',
                    aggregatedOutput: '', exitCode: 0, durationMs: 1, status: 'completed',
                },
            },
        });

        await expect(completion).resolves.toEqual({ aborted: false });
        const commandEndIndex = events.findIndex((event) => event.type === 'exec_command_end');
        const terminalIndex = events.findIndex((event) => event.type === 'task_complete');
        expect(commandEndIndex).toBeGreaterThanOrEqual(0);
        expect(terminalIndex).toBeGreaterThan(commandEndIndex);
        expect(events[terminalIndex]).toEqual(expect.objectContaining({
            type: 'task_complete',
            status: 'failed',
            error: 'provider failed',
        }));

        let mapperState = {
            currentTurnId: null as string | null,
            currentProviderTurnId: null as string | null,
        };
        const sessionEnvelopes = events.flatMap((event) => {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, mapperState);
            mapperState = mapped;
            return mapped.envelopes;
        });
        const lifecycleEnvelopes = sessionEnvelopes.filter((envelope) => (
            envelope.ev.t === 'turn-start'
            || envelope.ev.t === 'tool-call-start'
            || envelope.ev.t === 'tool-call-end'
            || envelope.ev.t === 'turn-end'
        ));
        expect(lifecycleEnvelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'tool-call-end',
            'turn-end',
        ]);
        expect(new Set(lifecycleEnvelopes.map((envelope) => envelope.turn))).toEqual(
            new Set([lifecycleEnvelopes[0].turn]),
        );
        expect(lifecycleEnvelopes[0].turn).toEqual(expect.any(String));

        await client.disconnect();
    });

    it('ignores a stale idle status from the previous turn while the next turn is starting', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        let turnStartCount = 0;
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-queued', path: '/tmp/thread-queued' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    turnStartCount += 1;
                    const turnId = turnStartCount === 1 ? 'turn-first' : 'turn-second';
                    setTimeout(() => {
                        if (turnId === 'turn-second') {
                            pushJsonLine(stdout, {
                                method: 'turn/started',
                                params: {
                                    threadId: 'thread-queued',
                                    turn: { id: 'turn-late-nested' },
                                },
                            });
                            pushJsonLine(stdout, {
                                method: 'thread/status/changed',
                                params: { threadId: 'thread-queued', status: { type: 'idle' } },
                            });
                        }

                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: turnId, items: [], status: 'inProgress', error: null },
                            },
                        });

                        if (turnId === 'turn-first') {
                            pushJsonLine(stdout, {
                                method: 'turn/started',
                                params: {
                                    threadId: 'thread-queued',
                                    turn: { id: turnId, items: [], status: 'inProgress', error: null },
                                },
                            });
                            pushJsonLine(stdout, {
                                method: 'item/completed',
                                params: {
                                    threadId: 'thread-queued',
                                    turnId,
                                    item: {
                                        type: 'agentMessage',
                                        id: 'msg-first',
                                        text: 'first done',
                                        phase: 'final_answer',
                                    },
                                },
                            });
                            return;
                        }

                        // The previous turn's idle notification can arrive after the
                        // next turn/start response but before its turn/started event.
                        setTimeout(() => {
                            pushJsonLine(stdout, {
                                method: 'thread/status/changed',
                                params: { threadId: 'thread-queued', status: { type: 'idle' } },
                            });
                        }, 0);
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await expect(client.sendTurnAndWait('first request')).resolves.toEqual({ aborted: false });

        let secondSettled = false;
        const second = client.sendTurnAndWait('second request').finally(() => {
            secondSettled = true;
        });
        await waitFor(() => turnStartCount === 2);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(secondSettled).toBe(false);
        expect(events.filter((event) => event.turn_id === 'turn-second')).toHaveLength(0);
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'turn/started',
            params: {
                threadId: 'thread-queued',
                turn: { id: 'turn-second', items: [], status: 'inProgress', error: null },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-queued',
                turnId: 'turn-second',
                item: {
                    type: 'agentMessage',
                    id: 'msg-second',
                    text: 'second done',
                    phase: 'final_answer',
                },
            },
        });

        await expect(second).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.turn_id === 'turn-second')).toEqual([
            expect.objectContaining({ type: 'task_started' }),
            expect.objectContaining({ type: 'task_complete' }),
        ]);

        await client.disconnect();
    });

    it('does not start a queued turn before the prior turn authoritative completion', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        let turnStartCount = 0;
        const proc = createMockProcess({
            pid: 3010,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-authoritative', path: '/tmp/thread-authoritative' },
                                model: 'gpt-test',
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    turnStartCount += 1;
                    const turnId = turnStartCount === 1 ? 'turn-first' : 'turn-second';
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { turn: { id: turnId } } });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-authoritative',
                                turn: { id: turnId, status: 'inProgress' },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-authoritative',
                                turnId,
                                item: {
                                    type: 'agentMessage',
                                    id: `msg-${turnId}`,
                                    text: `${turnId} done`,
                                    phase: 'final_answer',
                                },
                            },
                        });
                        if (turnId === 'turn-second') {
                            pushJsonLine(stdout, {
                                method: 'turn/completed',
                                params: {
                                    threadId: 'thread-authoritative',
                                    turn: { id: turnId, status: 'completed', error: null },
                                },
                            });
                        }
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const first = client.sendTurnAndWait('first request');
        const second = first.then(() => client.sendTurnAndWait('second request'));
        await waitFor(() => events.some((event) => (
            event.type === 'agent_message' && event.message === 'turn-first done'
        )));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(turnStartCount).toBe(1);
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-authoritative',
                turn: { id: 'turn-first', status: 'completed', error: null },
            },
        });

        await expect(first).resolves.toEqual({ aborted: false });
        await expect(second).resolves.toEqual({ aborted: false });
        expect(turnStartCount).toBe(2);

        await client.disconnect();
    });

    it('keeps waiting for the root turn when nested turn lifecycle events interleave', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3008,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-root', path: '/tmp/thread-root' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-root',
                                turn: { id: 'turn-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const pending = client.sendTurnAndWait('root request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started' && event.turn_id === 'turn-root'));
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'turn/started',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-nested', items: [], status: 'inProgress', error: null },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-nested', items: [], status: 'completed', error: null },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_started')).toEqual([
            expect.objectContaining({ turn_id: 'turn-root' }),
        ]);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                item: {
                    type: 'agentMessage',
                    id: 'msg-root',
                    text: 'root done',
                    phase: 'final_answer',
                },
            },
        });

        await expect(pending).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toEqual([
            expect.objectContaining({ turn_id: 'turn-root' }),
        ]);

        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-root', items: [], status: 'completed', error: null },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('keeps waiting for the root turn when legacy nested lifecycle events interleave', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3009,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-legacy-root', path: '/tmp/thread-legacy-root' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-legacy-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-legacy-root' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const pending = client.sendTurnAndWait('root request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started'));
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_started', turn_id: 'turn-legacy-nested' } },
        });
        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_complete', turn_id: 'turn-legacy-nested' } },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_started')).toEqual([
            expect.objectContaining({ turn_id: 'turn-legacy-root' }),
        ]);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_complete', turn_id: 'turn-legacy-root' } },
        });

        await expect(pending).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toEqual([
            expect.objectContaining({ turn_id: 'turn-legacy-root' }),
        ]);

        await client.disconnect();
    });

    it('maps raw goal notifications into legacy goal events', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-goal-1', path: '/tmp/thread-goal-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/updated',
                            params: {
                                threadId: 'thread-goal-1',
                                turnId: 'turn-goal-1',
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: 'finish the task',
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 11,
                                    timeUsedSeconds: 3,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680003,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/cleared',
                            params: { threadId: 'thread-goal-1' },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await waitFor(() => events.some((event) => event.type === 'thread_goal_cleared'));

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'thread_goal_updated',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
                turn_id: 'turn-goal-1',
                turnId: 'turn-goal-1',
                goal: expect.objectContaining({
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                    status: 'active',
                }),
            }),
            expect.objectContaining({
                type: 'thread_goal_cleared',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
            }),
        ]));

        await client.disconnect();
    });

    it('sends goal set and clear requests through app-server', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/goal/set' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: msg.params?.objective,
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 0,
                                    timeUsedSeconds: 0,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680001,
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/goal/clear' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { cleared: true },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await expect(client.setGoal({
            threadId: 'thread-goal-1',
            objective: 'finish the task',
        })).resolves.toMatchObject({
            goal: {
                threadId: 'thread-goal-1',
                objective: 'finish the task',
                status: 'active',
            },
        });
        await expect(client.clearGoal({
            threadId: 'thread-goal-1',
        })).resolves.toEqual({ cleared: true });

        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: {
                    threadId: 'thread-goal-1',
                },
            }),
        ]));

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                    'MONETIZATION.md': {
                        kind: { type: 'add', move_path: null },
                        add: { content: '# Monetization\n\nPaid plans.\n' },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'patch-approval-1',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('falls back to final answer completion when raw turn/completed is missing', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('say hi')).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'happy',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the happy MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'happy:77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'happy',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });

    describe('prepareSideCommand', () => {
        it('launches plain codex with the app-server environment when there is no proxy or sandbox', async () => {
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient();
            try {
                await client.connect();
                const launch = await client.prepareSideCommand(['mcp', 'list', '--json']);
                expect(launch).toEqual({ command: 'codex', args: ['mcp', 'list', '--json'], env: expect.objectContaining({ PATH: process.env.PATH }) });
                expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
            } finally {
                await client.disconnect();
            }
        });

        it('routes through the same multi-auth proxy account as the app-server', async () => {
            mockPrepareCodexMultiAuthProxy.mockResolvedValue({
                args: ['-c', 'model_provider="codex-multi-auth-runtime-proxy"'],
                env: { PATH: '/usr/bin', OPENAI_API_KEY: 'local-client-key' },
                cleanup: mockProxyCleanup,
            });
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient();
            try {
                await client.connect();
                const launch = await client.prepareSideCommand(['exec', '-']);
                expect(launch?.args).toEqual(['-c', 'model_provider="codex-multi-auth-runtime-proxy"', 'exec', '-']);
                expect(launch?.env.OPENAI_API_KEY).toBe('local-client-key');
            } finally {
                await client.disconnect();
            }
        });

        it('wraps the side command in the same sandbox as the app-server', async () => {
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig, undefined, undefined, 'owner-choice');
            try {
                await client.connect();
                mockWrapForMcpTransport.mockClear();
                mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex exec -'] });
                const launch = await client.prepareSideCommand(['exec', '-']);
                expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['exec', '-']);
                expect(launch?.command).toBe('sh');
                expect(launch?.args).toEqual(['-c', 'wrapped codex exec -']);
                if (process.platform === 'darwin') expect(launch?.env.CODEX_SANDBOX).toBe('seatbelt');
            } finally {
                await client.disconnect();
            }
        });

        it.each([
            ['a managed provider', [undefined, 'owner-choice', ['-c', 'managed-provider']]],
            ['a mandatory sandbox policy', [sandboxConfig, 'mandatory', undefined]],
        ] as const)('refuses for %s', async (_label, [config, policy, managedArgs]) => {
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(config, undefined, undefined, policy, managedArgs ? [...managedArgs] : undefined);
            expect(client.sideCommandAllowed).toBe(false);
            try {
                await client.connect();
                expect(await client.prepareSideCommand(['exec', '-'])).toBeNull();
            } finally {
                await client.disconnect();
            }
        });

        it('refuses before the app-server is connected', async () => {
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient();
            expect(client.sideCommandAllowed).toBe(true);
            expect(await client.prepareSideCommand(['exec', '-'])).toBeNull();
        });
    });
});

/**
 * A managed Cloud run configures its own provider, and only its own.
 *
 * Account rotation exists to spread load across the operator's own Codex
 * accounts. For a managed run that is a different payer and a provider outside
 * the approval, so it must not be consulted at all — consulting it has already
 * started a proxy and picked an account by the time anything could override it.
 */
describe('CodexAppServerClient for a managed Cloud run', () => {
    const MANAGED_ARGS = [
        '-c', 'model_providers.saycode-managed.name="Saycode managed gateway"',
        '-c', 'model_providers.saycode-managed.base_url="https://studio.example.test/api/cloud/gateway/openai/v1"',
        '-c', 'model_providers.saycode-managed.env_key="OPENAI_API_KEY"',
        '-c', 'model_providers.saycode-managed.requires_openai_auth=false',
        '-c', 'model_providers.saycode-managed.wire_api="responses"',
        '-c', 'model_provider="saycode-managed"',
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        mockExecSync.mockReturnValue('codex-cli 0.140.0');
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: ['-c', 'model_provider="codex-multi-auth"'],
            env: { OPENAI_API_KEY: 'another-accounts-key' },
            cleanup: mockProxyCleanup,
        });
        mockProxyCleanup.mockResolvedValue(undefined);
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    it('never consults account rotation, and starts with the managed provider', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(undefined, undefined, undefined, undefined, MANAGED_ARGS);
        await client.connect();

        expect(mockPrepareCodexMultiAuthProxy).not.toHaveBeenCalled();
        const [, args] = mockSpawn.mock.calls[0];
        for (const expected of MANAGED_ARGS) expect(args).toContain(expected);
        // Not the rotation's provider, and not whatever the config file says.
        expect(args).not.toContain('model_provider="codex-multi-auth"');
    });

    it('still uses account rotation for an ordinary run', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();

        expect(mockPrepareCodexMultiAuthProxy).toHaveBeenCalled();
        const [, args] = mockSpawn.mock.calls[0];
        expect(args).toContain('model_provider="codex-multi-auth"');
    });
});


describe('explicit authentication recovery', () => {
    beforeEach(() => {
        mockSpawn.mockReset();
        mockPrepareCodexMultiAuthProxy.mockResolvedValue(null);
        mockExecSync.mockReturnValue('codex-cli 0.140.0');
    });
    it('waits for the old process to exit and preserves the original thread after failed resume', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        let exited = false;
        const old = createMockProcess({ exitDelayMs: 30, onExit: () => { exited = true; } });
        const requests: MockRpcMessage[] = [];
        const next = createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg);
            if (msg.method === 'account/read') pushJsonLine(stdout, { id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
            if (msg.method === 'account/rateLimits/read') pushJsonLine(stdout, { id: msg.id, result: { rateLimits: { primary: { usedPercent: 20 } } } });
            if (msg.method === 'thread/resume') pushJsonLine(stdout, { id: msg.id, error: { code: -1, message: 'cannot resume' } });
        } });
        mockSpawn.mockReturnValueOnce(old).mockImplementationOnce(() => {
            expect(exited).toBe(true);
            return next;
        });
        const client = new CodexAppServerClient();
        await client.connect();
        (client as any)._threadId = 'original';
        (client as any).threadDefaults = { model: 'gpt-6-astra', cwd: '/project', approvalPolicy: 'never', mcpServers: { local: {} } };
        await expect(client.reconnectForAuth()).rejects.toThrow('resume-failed');
        expect(client.threadId).toBe('original');
        expect(requests.find(x => x.method === 'thread/resume')?.params).toMatchObject({ threadId: 'original', model: 'gpt-6-astra', cwd: '/project', approvalPolicy: 'never' });
        expect(requests.some(x => x.method === 'thread/start' || x.method === 'turn/start')).toBe(false);
        await client.disconnect();
    });

    it('does not report recovery when the replacement ChatGPT account is also exhausted', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const methods: string[] = [];
        mockSpawn.mockReturnValueOnce(createMockProcess()).mockReturnValueOnce(createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method) methods.push(msg.method);
            if (msg.method === 'account/read') pushJsonLine(stdout, { id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
            if (msg.method === 'account/rateLimits/read') pushJsonLine(stdout, { id: msg.id, result: { rateLimits: { primary: { usedPercent: 100 }, secondary: null } } });
            if (msg.method === 'thread/resume') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'original' }, model: 'gpt-6-astra' } });
        } }));
        const client = new CodexAppServerClient();
        await client.connect();
        (client as any)._threadId = 'original';
        await expect(client.reconnectForAuth()).rejects.toThrow('limit-reached');
        expect(methods).not.toContain('thread/resume');
        expect(client.threadId).toBe('original');
        await client.disconnect();
    });

    it('resumes the same thread after checking the replacement account and its quota', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockReturnValueOnce(createMockProcess()).mockReturnValueOnce(createMockProcess({ onRequest: (msg, stdout) => {
            requests.push(msg);
            if (msg.method === 'account/read') pushJsonLine(stdout, { id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
            if (msg.method === 'account/rateLimits/read') pushJsonLine(stdout, { id: msg.id, result: { rateLimits: { primary: { usedPercent: 25 } } } });
            if (msg.method === 'thread/resume') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'original' }, model: 'gpt-6-astra' } });
        } }));
        const client = new CodexAppServerClient();
        await client.connect();
        (client as any)._threadId = 'original';
        await expect(client.reconnectForAuth()).resolves.toBe('authenticated');
        expect(client.threadId).toBe('original');
        expect(requests.map(x => x.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'thread/resume']);
        expect(mockPrepareCodexMultiAuthProxy).toHaveBeenCalled();
        await client.disconnect();
    });

    it('does not spawn a replacement when the old process cannot be confirmed dead', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const old = createMockProcess();
        old.kill.mockImplementation(() => true);
        mockSpawn.mockReturnValue(old);
        const client = new CodexAppServerClient();
        await client.connect();
        (client as any)._threadId = 'original';
        const timeout = (CodexAppServerClient as any).PROCESS_EXIT_WAIT_MS;
        (CodexAppServerClient as any).PROCESS_EXIT_WAIT_MS = 20;
        try {
            await expect(client.reconnectForAuth()).rejects.toThrow('restart-failed');
            expect(mockSpawn).toHaveBeenCalledTimes(1);
            expect(client.threadId).toBe('original');
        } finally {
            (CodexAppServerClient as any).PROCESS_EXIT_WAIT_MS = timeout;
            old.exitCode = 0;
            old.emit('exit', 0, null);
            await client.disconnect();
        }
    });

    it('refuses recovery while a goal-control RPC is still pending', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        let reply!: () => void;
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'thread/goal/set') reply = () => pushJsonLine(stdout, { id: msg.id, result: { goal: {} } });
        } });
        mockSpawn.mockReturnValue(proc);
        const client = new CodexAppServerClient();
        await client.connect();
        (client as any)._threadId = 'original';
        const goal = client.setGoal({ threadId: 'original', objective: 'test' });
        await expect(client.reconnectForAuth()).rejects.toThrow('restart-failed');
        expect(proc.kill).not.toHaveBeenCalled();
        reply();
        await goal;
        await client.disconnect();
    });

    it('fails closed when the new process has no authenticated account', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        mockSpawn.mockReturnValueOnce(createMockProcess()).mockReturnValueOnce(createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'account/read') pushJsonLine(stdout, { id: msg.id, result: { account: null, requiresOpenaiAuth: true } });
        } }));
        const client = new CodexAppServerClient();
        await client.connect();
        (client as any)._threadId = 'original';
        await expect(client.reconnectForAuth()).rejects.toThrow('authentication-required');
        expect(client.threadId).toBe('original');
        await client.disconnect();
    });
    it.each([false, true])('finishes an authoritative turn with background work (query fails=%s)', async (unavailable) => {
        const events: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({ onRequest: (msg, stdout) => {
            if (msg.method === 'thread/start') pushJsonLine(stdout, { id: msg.id, result: { thread: { id: 'bg-thread' } } });
            if (msg.method === 'thread/backgroundTerminals/list') {
                pushJsonLine(stdout, unavailable
                    ? { id: msg.id, error: { code: -32601, message: 'not supported' } }
                    : { id: msg.id, result: { data: [{ itemId: 'bg-cmd', processId: '42', command: 'vite' }], nextCursor: null } });
            }
            if (msg.method === 'turn/start') setTimeout(() => {
                pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'bg-turn' } } });
                pushJsonLine(stdout, { method: 'turn/started', params: { threadId: 'bg-thread', turn: { id: 'bg-turn' } } });
                pushJsonLine(stdout, { method: 'item/started', params: { threadId: 'bg-thread', turnId: 'bg-turn', item: { type: 'commandExecution', id: 'bg-cmd', command: 'vite' } } });
                // Interleaved text is not a terminal signal.
                pushJsonLine(stdout, { method: 'item/completed', params: { threadId: 'bg-thread', turnId: 'bg-turn', item: { type: 'agentMessage', id: 'text', text: 'server started', phase: 'commentary' } } });
                setTimeout(() => pushJsonLine(stdout, { method: 'turn/completed', params: { threadId: 'bg-thread', turn: { id: 'bg-turn', status: 'completed' } } }), 30);
            }, 0);
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setEventHandler(event => events.push(event as Record<string, unknown>));
        await client.connect();
        await client.startThread({ model: 'gpt-test', cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' });
        const turn = client.sendTurnAndWait('start server');
        await waitFor(() => events.some(event => event.type === 'agent_message'));
        expect(events.some(event => event.type === 'task_complete')).toBe(false);
        await waitFor(() => events.some(event => event.type === 'task_complete'), 2500);
        await expect(turn).resolves.toEqual({ aborted: false });
        expect(events).toContainEqual(expect.objectContaining({ type: 'background_tasks', tasks: [expect.objectContaining({ callId: 'bg-cmd', status: unavailable ? 'unknown' : 'running' })] }));
        // Transferring ownership is not a fabricated successful process exit.
        expect(events.some(event => event.type === 'exec_command_end')).toBe(false);
        pushJsonLine(proc.stdout, { method: 'item/completed', params: { threadId: 'bg-thread', turnId: 'bg-turn', item: { type: 'commandExecution', id: 'bg-cmd', exitCode: 0, status: 'completed' } } });
        await waitFor(() => events.some(event => event.type === 'exec_command_end'));
        expect(events.filter(event => event.type === 'background_tasks').at(-1)?.tasks).toEqual([]);
        expect(events.filter(event => event.type === 'task_complete')).toHaveLength(1);
        await client.disconnect();
    });

});
