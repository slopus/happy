import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://server.test',
        currentCliVersion: 'test',
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    },
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn(),
}));

vi.mock('@/utils/time', () => ({
    backoff: vi.fn(async <T>(callback: () => Promise<T>) => callback()),
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(async () => ({ claude: false, codex: false, gemini: false, openclaw: false })),
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(async () => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false,
    })),
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: vi.fn(() => true),
}));

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        metadata: {
            host: 'localhost',
            platform: 'linux',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib',
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

describe('ApiMachineClient proxy support', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIo.mockReturnValue({
            on: vi.fn(),
            io: {
                on: vi.fn(),
            },
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('passes a websocket proxy agent when proxy env is configured', () => {
        vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:5901');

        new ApiMachineClient('fake-token', makeMachine()).connect();

        const socketOptions = mockIo.mock.calls[0][1];
        expect(socketOptions.transportOptions.websocket.agent).toBeDefined();
    });
});
