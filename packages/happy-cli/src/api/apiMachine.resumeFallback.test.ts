import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';

const { handlers } = vi.hoisted(() => ({
    handlers: new Map<string, (params: any) => Promise<any>>()
}));

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), connect: vi.fn(), emit: vi.fn(), io: { on: vi.fn() } })) }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'http://127.0.0.1:3005', currentCliVersion: 'test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('@/utils/detectCLI', () => ({ detectCLIAvailability: vi.fn(() => ({ claude: false, codex: false, gemini: false, openclaw: false })) }));
vi.mock('@/utils/lidState', () => ({ shouldReconnect: vi.fn(() => true) }));
vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn((method: string, handler: any) => { handlers.set(method, handler); });
        unregisterHandler = vi.fn((method: string) => { handlers.delete(method); });
        hasHandler = vi.fn((method: string) => handlers.has(method));
    }
}));

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'linux',
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

const validFallback = {
    metadata: { path: '/home/user/project', claudeSessionId: 'claude-1' },
    metadataVersion: 3,
    agentStateVersion: 4,
    seq: 12,
    encryptionKey: 'AQIDBA==',
    encryptionVariant: 'dataKey'
};

describe('resume-happy-session fallback payload', () => {
    let resumeSession: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        handlers.clear();
        resumeSession = vi.fn(async () => ({ type: 'success', sessionId: 'session-1' }) as any);
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            resumeSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn()
        } as any);
    });

    it('forwards a well-formed fallback so untracked sessions can resume', async () => {
        await handlers.get('resume-happy-session')!({ sessionId: 'session-1', fallback: validFallback });
        expect(resumeSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ fallback: validFallback }));
    });

    it('drops a malformed fallback instead of failing the call', async () => {
        await handlers.get('resume-happy-session')!({ sessionId: 'session-1', fallback: { metadata: {} } });
        expect(resumeSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ fallback: undefined }));
    });
});
