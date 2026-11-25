import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';
import type { ComponentObservation } from '@slopus/happy-wire';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { createProcessRunner } from '@/environment/processRunner';
import { createGitHubCliAdapter } from '@/environment/githubCliAdapter';
import { createPawsCliAdapter } from '@/environment/pawsCliAdapter';
import { createEgoBrowserAdapter } from '@/environment/egoBrowserAdapter';
import { createWranglerAdapter } from '@/environment/wranglerAdapter';
import { createCloudflaredAdapter } from '@/environment/cloudflaredAdapter';
import { createEnvironmentService } from '@/environment/environmentService';
import { registerEnvironmentHandlers } from '@/environment/registerEnvironmentHandlers';

const {
    mockIo,
    mockShouldReconnect,
    rpcHandlers,
    mockLoggerDebug,
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true),
    rpcHandlers: new Map<string, (params: any) => any>(),
    mockLoggerDebug: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test',
        happyHomeDir: '/tmp/happy-api-machine-test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mockLoggerDebug,
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/environment/processRunner', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/environment/processRunner')>(),
    createProcessRunner: vi.fn(() => ({ run: vi.fn(async () => { throw new Error('No processes in machine RPC tests'); }) })),
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        private readonly handlers = new Map<string, (params: any) => any>();
        private socket: any;

        constructor(private readonly config: { scopePrefix: string, encryptionKey: Uint8Array, encryptionVariant: Machine['encryptionVariant'] }) {}

        onSocketConnect = vi.fn((socket: any) => {
            this.socket = socket;
            for (const method of this.handlers.keys()) {
                socket.emit('rpc-register', { method });
            }
        });
        onSocketDisconnect = vi.fn(() => {
            this.socket = undefined;
        });
        handleRequest = vi.fn(async (request: { method: string, params: string }) => {
            const handler = this.handlers.get(request.method);
            if (!handler) throw new Error(`No handler for ${request.method}`);
            const params = decrypt(this.config.encryptionKey, this.config.encryptionVariant, decodeBase64(request.params));
            const result = await handler(params);
            return encodeBase64(encrypt(this.config.encryptionKey, this.config.encryptionVariant, result));
        });
        hasHandler = vi.fn((method: string) => this.handlers.has(`${this.config.scopePrefix}:${method}`));
        registerHandler = vi.fn((method: string, handler: (params: any) => any) => {
            const prefixedMethod = `${this.config.scopePrefix}:${method}`;
            this.handlers.set(prefixedMethod, handler);
            rpcHandlers.set(method, handler);
            this.socket?.emit('rpc-register', { method: prefixedMethod });
        });
        unregisterHandler = vi.fn((method: string) => {
            const prefixedMethod = `${this.config.scopePrefix}:${method}`;
            this.handlers.delete(prefixedMethod);
            rpcHandlers.delete(method);
            this.socket?.emit('rpc-unregister', { method: prefixedMethod });
        });
    }
}));

vi.mock('@/environment/githubCliAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/environment/githubCliAdapter')>();
    return {
        ...actual,
        createGitHubCliAdapter: vi.fn((deps: Parameters<typeof actual.createGitHubCliAdapter>[0]) => {
            let state: ComponentObservation = {
                componentId: 'github-cli', platform: 'darwin', architecture: 'arm64', support: 'supported',
                installed: true, installedVersion: '2.79.0', resolvedExecutable: '/opt/homebrew/bin/gh',
                source: { kind: 'homebrew', available: true, latestVersion: '2.80.0', ownership: 'verified' },
                capability: 'alignable', details: { kind: 'github-cli' },
                authentication: { provider: 'github.com', status: 'authenticated' }, inspectedAt: Date.now(),
            };
            return {
                id: 'github-cli',
                alignment: 'supported',
                inspect: async () => structuredClone(state),
                plan: actual.createGitHubCliAdapter(deps).plan,
                apply: async () => {
                    state = { ...state, installedVersion: '2.80.0' };
                    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
                },
            };
        }),
    };
});

vi.mock('@/environment/pawsCliAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/environment/pawsCliAdapter')>();
    return { ...actual, createPawsCliAdapter: vi.fn(actual.createPawsCliAdapter) };
});

vi.mock('@/environment/egoBrowserAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/environment/egoBrowserAdapter')>();
    return { ...actual, createEgoBrowserAdapter: vi.fn(actual.createEgoBrowserAdapter) };
});

vi.mock('@/environment/wranglerAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/environment/wranglerAdapter')>();
    return { ...actual, createWranglerAdapter: vi.fn(actual.createWranglerAdapter) };
});

vi.mock('@/environment/cloudflaredAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/environment/cloudflaredAdapter')>();
    return { ...actual, createCloudflaredAdapter: vi.fn(actual.createCloudflaredAdapter) };
});

vi.mock('@/environment/environmentService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/environment/environmentService')>();
    return { ...actual, createEnvironmentService: vi.fn(actual.createEnvironmentService) };
});

vi.mock('@/environment/registerEnvironmentHandlers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/environment/registerEnvironmentHandlers')>();
    return { ...actual, registerEnvironmentHandlers: vi.fn(actual.registerEnvironmentHandlers) };
});

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        ask: true,
        claude: false,
        codex: false,
        gemini: false,
        opencode: false,
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

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let managerHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        rpcHandlers.clear();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        managerHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            off: vi.fn((event: string, handler: SocketHandler) => {socketHandlers[event]=(socketHandlers[event]||[]).filter(value=>value!==handler);}),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn((event: string, handler: SocketHandler) => {
                    if (!managerHandlers[event]) managerHandlers[event] = [];
                    managerHandlers[event].push(handler);
                })
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('advertises delegation only after its handler is installed on an existing machine', async () => {
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        const update = vi.spyOn(client, 'updateMachineMetadata').mockImplementation(async handler => {
            machine.metadata = handler(machine.metadata);
        });
        vi.spyOn(client, 'updateDaemonState').mockResolvedValue(undefined);
        client.connect();
        try {
            emitSocketEvent('connect');
            expect(update).not.toHaveBeenCalled();
            mockSocket.connected = true;
            const delegation = vi.fn(async () => ({ success: true, roles: [] }));
            const delegationConnected = vi.fn();
            client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(), delegation, delegationConnected });
            expect(machine.metadata?.delegation).toBe(1);
            expect(delegationConnected).toHaveBeenCalledTimes(1);
            expect(machine.metadata?.host).toBe('localhost');
            expect(await rpcHandlers.get('delegation')?.({ action: 'roles-list', parentSessionId: 'parent' })).toEqual({ success: true, roles: [] });
            expect(delegation).toHaveBeenCalledExactlyOnceWith({ action: 'roles-list', parentSessionId: 'parent' });
            expect(() => rpcHandlers.get('delegation')?.({ action: 'read', parentSessionId: 'parent' })).toThrow();
            const writes = update.mock.calls.length;
            emitSocketEvent('connect');
            expect(update).toHaveBeenCalledTimes(writes);
        } finally { client.shutdown(); }
    });

    it('installs machine role CRUD independently of a live parent and advertises its separate capability', async () => {
        const machine = makeMachine(), client = new ApiMachineClient('fake-token', machine);
        const update = vi.spyOn(client, 'updateMachineMetadata').mockImplementation(async handler => { machine.metadata = handler(machine.metadata); });
        vi.spyOn(client, 'updateDaemonState').mockResolvedValue(undefined);
        client.connect();
        try {
            emitSocketEvent('connect'); expect(machine.metadata?.delegationRoles).toBeUndefined();
            mockSocket.connected = true;
            const delegationRoles = vi.fn(async () => ({ success: true, roles: [] }));
            client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(), delegationRoles });
            expect(machine.metadata?.delegationRoles).toBe(1); expect(machine.metadata?.delegation).toBeUndefined();
            expect(await rpcHandlers.get('delegation-roles')!({ action: 'list' })).toEqual({ success: true, roles: [] });
            expect(delegationRoles).toHaveBeenCalledExactlyOnceWith({ action: 'list' });
            expect(() => rpcHandlers.get('delegation-roles')!({ action: 'list', parentSessionId: 'spoof' })).toThrow();
            const writes = update.mock.calls.length; emitSocketEvent('connect'); expect(update).toHaveBeenCalledTimes(writes);
        } finally { client.shutdown(); }
    });

    it.each(['legacy', 'dataKey'] as const)('uses the existing relay with %s encryption and rejects unconfirmed worker replies', async variant => {
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        const encryption = { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: variant };
        client.connect();
        mockSocket.connected = true;
        mockSocket.timeout = vi.fn(() => mockSocket);
        mockSocket.emitWithAck.mockResolvedValue({ ok: true, result: encodeBase64(encrypt(encryption.encryptionKey, variant, { model: 'observed' })) });
        try {
            expect(await client.callSessionRpc('child', encryption, 'delegation-prepare', { model: 'observed' }, 90_000)).toEqual({ model: 'observed' });
            const [event, payload] = mockSocket.emitWithAck.mock.calls[0];
            expect(event).toBe('rpc-call');
            expect(payload.method).toBe('child:delegation-prepare');
            expect(decrypt(encryption.encryptionKey, variant, decodeBase64(payload.params))).toEqual({ model: 'observed' });
            expect(mockSocket.timeout).toHaveBeenCalledWith(90_000);
            mockSocket.emitWithAck.mockResolvedValue({ ok: false, error: 'worker disconnected' });
            await expect(client.callSessionRpc('child', encryption, 'delegation-prepare', {})).rejects.toThrow('worker disconnected');
            mockSocket.emitWithAck.mockResolvedValue({ ok: true, result: encodeBase64(encrypt(encryption.encryptionKey, variant, { error: 'invalid native model' })) });
            await expect(client.callSessionRpc('child', encryption, 'delegation-prepare', {})).rejects.toThrow('invalid native model');
        } finally { client.shutdown(); }
    });

    it('advertises scheduling on an existing machine immediately and preserves concurrent metadata edits', async () => {
        vi.useFakeTimers();
        const machine = makeMachine();
        const saved = { ...machine.metadata, displayName: 'My Mac', crossAgentContinuation: 1 as const };
        machine.metadata = saved;
        machine.metadataVersion = 7;
        const concurrent = { ...saved, displayName: 'Renamed in App', homeDir: '/updated/home' };
        const sent: Array<{ expectedVersion: number; metadata: unknown }> = [];
        mockSocket.emitWithAck.mockImplementation(async (event: string, payload: { expectedVersion: number; metadata: string }) => {
            expect(event).toBe('machine-update-metadata');
            sent.push({ expectedVersion: payload.expectedVersion, metadata: decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(payload.metadata)) });
            return sent.length === 1
                ? { result: 'version-mismatch', version: 8, metadata: encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, concurrent)) }
                : { result: 'success', version: 9, metadata: payload.metadata };
        });
        const client = new ApiMachineClient('fake-token', machine);
        const runner = { wake: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
        vi.spyOn(client, 'updateDaemonState').mockResolvedValue(undefined);
        client.setScheduledTaskRunner(runner);
        client.connect();
        try {
            emitSocketEvent('connect');
            expect(sent).toEqual([{ expectedVersion: 7, metadata: { ...saved, scheduledTasks: 1 } }]);
            await vi.advanceTimersByTimeAsync(1000);
            expect(sent).toEqual([
                { expectedVersion: 7, metadata: { ...saved, scheduledTasks: 1 } },
                { expectedVersion: 8, metadata: { ...concurrent, scheduledTasks: 1 } },
            ]);
            expect(machine.metadata).toEqual({ ...concurrent, scheduledTasks: 1 });
            expect(machine.metadataVersion).toBe(9);
            emitSocketEvent('connect');
            expect(sent).toHaveLength(2);
        } finally {
            client.shutdown();
        }
    });

    it('does not advertise scheduling without an installed runner', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        const update = vi.spyOn(client, 'updateMachineMetadata');
        vi.spyOn(client, 'updateDaemonState').mockResolvedValue(undefined);
        client.connect();
        try {
            emitSocketEvent('connect');
            expect(update).not.toHaveBeenCalled();
        } finally {
            client.shutdown();
        }
    });

    it('removes work-wake subscriptions on reconnect, disconnect and shutdown', () => {
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();
        emitSocketEvent('connect');
        expect(socketHandlers.ephemeral).toHaveLength(1);
        emitSocketEvent('connect');
        expect(socketHandlers.ephemeral).toHaveLength(1);
        emitSocketEvent('disconnect', 'test');
        expect(socketHandlers.ephemeral).toHaveLength(0);
        emitSocketEvent('connect');
        expect(socketHandlers.ephemeral).toHaveLength(1);
        client.shutdown();
        expect(socketHandlers.ephemeral).toHaveLength(0);
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

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    it('retains daemon-issued environment previews across socket reconnects', async () => {
        vi.useFakeTimers();
        const machine = makeMachine();
        const client = new ApiMachineClient('fake-token', machine);
        vi.spyOn(client, 'updateDaemonState').mockResolvedValue(undefined);
        client.connect();

        const callRpc = (method: string, raw: unknown): Promise<any> => new Promise((resolve) => {
            emitSocketEvent('rpc-request', {
                method: `${machine.id}:${method}`,
                params: encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, raw)),
            }, (response: string) => resolve(decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(response))));
        });

        try {
            mockSocket.connected = true;
            emitSocketEvent('connect');
            expect(mockSocket.emit.mock.calls.filter(([event, payload]: [string, { method?: string }]) => event === 'rpc-register' && payload.method?.startsWith('test-machine-id:environment-'))).toEqual([
                ['rpc-register', { method: 'test-machine-id:environment-inspect' }],
                ['rpc-register', { method: 'test-machine-id:environment-inspect-v2' }],
                ['rpc-register', { method: 'test-machine-id:environment-apply' }],
            ]);
            const desired = { componentId: 'github-cli', targetVersion: '2.80.0' };
            const preview = await callRpc('environment-inspect', { componentIds: ['github-cli'], desired });
            expect(preview.plans[0].action).toBe('upgrade');
            const approvedAt = Date.now();

            mockSocket.connected = false;
            emitSocketEvent('disconnect', 'transport close');
            await vi.advanceTimersByTimeAsync(1000);
            expect(mockSocket.connect).toHaveBeenCalledOnce();
            mockSocket.connected = true;
            emitSocketEvent('connect');

            const response = await callRpc('environment-apply', { desired, plan: preview.plans[0], approvedAt });
            expect(response.result).toMatchObject({
                status: 'succeeded', changed: true, after: { installedVersion: '2.80.0' },
            });
            expect(mockSocket.emit.mock.calls.filter(([event, payload]: [string, { method?: string }]) => event === 'rpc-register' && payload.method?.startsWith('test-machine-id:environment-'))).toHaveLength(6);
            expect(registerEnvironmentHandlers).toHaveBeenCalledOnce();
            const registration = vi.mocked(registerEnvironmentHandlers).mock.calls[0]!;
            expect(typeof registration[0].registerHandler).toBe('function');
            // Chai treats an object's inspect() as a formatter; compare identity without formatting the service.
            expect(registration[1] === vi.mocked(createEnvironmentService).mock.results[0]?.value).toBe(true);
            expect(createEnvironmentService).toHaveBeenCalledOnce();
            expect(createProcessRunner).toHaveBeenCalledOnce();
            expect(createGitHubCliAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                runner: vi.mocked(createProcessRunner).mock.results[0]?.value,
                env: process.env, platform: process.platform, architecture: process.arch,
                resolveExecutable: expect.any(Function), resolveRealpath: expect.any(Function), now: expect.any(Function),
            }));
            expect(vi.mocked(createEnvironmentService).mock.calls[0]?.[0].map((adapter) => adapter.id)).toEqual([
                'github-cli', 'paws-cli', 'ego-browser', 'cloudflare-wrangler', 'cloudflared',
            ]);
            expect(createPawsCliAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                runner: vi.mocked(createProcessRunner).mock.results[0]?.value,
                env: process.env, platform: process.platform, architecture: process.arch,
                resolveExecutable: expect.any(Function), resolveRealpath: expect.any(Function), now: expect.any(Function),
            }));
            expect(createEgoBrowserAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                runner: vi.mocked(createProcessRunner).mock.results[0]?.value,
                env: process.env, homeDirectory: expect.any(String), platform: process.platform,
                architecture: process.arch, resolveExecutable: expect.any(Function),
                readPlistValue: expect.any(Function), now: expect.any(Function),
            }));
            expect(createWranglerAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                runner: vi.mocked(createProcessRunner).mock.results[0]?.value,
                env: process.env, platform: process.platform, architecture: process.arch,
                resolveExecutable: expect.any(Function), now: expect.any(Function),
            }));
            expect(createCloudflaredAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                runner: vi.mocked(createProcessRunner).mock.results[0]?.value,
                env: process.env, homeDirectory: expect.any(String), platform: process.platform,
                architecture: process.arch, resolveExecutable: expect.any(Function),
                pathExists: expect.any(Function), now: expect.any(Function),
            }));
        } finally {
            client.shutdown();
        }
    });

    it('propagates a startup trace into the daemon spawn without logging sensitive params', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const handler = rpcHandlers.get('spawn-happy-session');
        expect(handler).toBeDefined();
        await handler?.({
            directory: '/private/project',
            agent: 'codex',
            traceId: '00000000-0000-4000-8000-000000000001',
            token: 'token-canary',
            codexSessionGrant: 'grant-canary',
            model: 'gpt-5.6-luna',
            effort: 'low',
            prompt: 'prompt-canary',
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/private/project',
            agent: 'codex',
            traceId: '00000000-0000-4000-8000-000000000001',
            machineId: 'test-machine-id',
            codexSessionGrant: 'grant-canary',
            model: 'gpt-5.6-luna',
            effort: 'low',
        }));
        expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain('canary');
    });

    it('exposes a machine RPC that refreshes Codex usage on demand', async () => {
        const refreshCodexUsage = vi.fn().mockResolvedValue(undefined);
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            refreshCodexUsage,
        });

        const handler = rpcHandlers.get('refresh-codex-usage');
        expect(handler).toBeDefined();
        await expect(handler?.({})).resolves.toEqual({ type: 'success' });
        expect(refreshCodexUsage).toHaveBeenCalledTimes(1);
    });

    it('accepts only an opaque grant for an explicitly requested account quota probe', async () => {
        const refreshCodexAccountQuota = vi.fn().mockResolvedValue({ type: 'success', accepted: true });
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn(), refreshCodexAccountQuota });
        const handler = rpcHandlers.get('refresh-codex-account-quota');
        await expect(handler?.({ grant: 'a'.repeat(43) })).resolves.toEqual({ type: 'success', accepted: true });
        await expect(handler?.({ grant: 'not-a-grant' })).rejects.toThrow(/valid Codex quota probe grant/i);
        expect(refreshCodexAccountQuota).toHaveBeenCalledWith('a'.repeat(43));
    });

    it('uses the ordinary startup RPC for a fresh explicit Magpie launch', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'magpie-session' });
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({ spawnSession, stopSession: vi.fn(), requestShutdown: vi.fn() });
        const handler = rpcHandlers.get('spawn-happy-session')!;
        const params = { directory: '/repo', agent: 'codex', model: { connection: 'magpie', id: 'openrouter/google/gemini' } };

        await expect(handler({ ...params, codexSessionGrant: 'bound-grant' })).rejects.toThrow(/fresh native Codex/);
        await expect(handler({ ...params, model: { connection: 'magpie' } })).rejects.toThrow(/fresh native Codex/);
        expect(spawnSession).not.toHaveBeenCalled();
        await expect(handler(params)).resolves.toEqual({ type: 'success', sessionId: 'magpie-session' });
        expect(spawnSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            magpieModel: 'openrouter/google/gemini', model: undefined, codexSessionGrant: undefined,
        }));
    });

    it('does not log an absolute directory when approval is required', async () => {
        const spawnSession = vi.fn().mockResolvedValue({
            type: 'requestToApproveDirectoryCreation',
            directory: '/private/approval-directory-canary',
        });
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({ spawnSession, stopSession: vi.fn(), requestShutdown: vi.fn() });

        await rpcHandlers.get('spawn-happy-session')?.({
            directory: '/private/approval-directory-canary',
            agent: 'codex',
        });

        expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain('approval-directory-canary');
    });

    it('does not include raw socket error values in logs', () => {
        vi.useFakeTimers();
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        emitSocketEvent('connect_error', new Error('connect-secret-canary'));
        managerHandlers.error?.forEach((handler) => handler(new Error('socket-secret-canary')));

        expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain('secret-canary');
        client.shutdown();
    });
});
