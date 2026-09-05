import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';

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

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        hasHandler = vi.fn(() => false);
        registerHandler = vi.fn((method: string, handler: (params: any) => any) => {
            rpcHandlers.set(method, handler);
        });
        unregisterHandler = vi.fn();
    }
}));

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
            prompt: 'prompt-canary',
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/private/project',
            agent: 'codex',
            traceId: '00000000-0000-4000-8000-000000000001',
            machineId: 'test-machine-id',
        }));
        expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain('canary');
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
