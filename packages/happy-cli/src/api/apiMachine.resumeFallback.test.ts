import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';

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
    metadata: { path: '/home/user/project', machineId: 'test-machine-id', claudeSessionId: 'claude-1' },
    metadataVersion: 3,
    agentStateVersion: 4,
    seq: 12,
    encryptionKey: Buffer.alloc(32, 1).toString('base64'),
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

    it('preserves nullable flavor and empty provider IDs for the metadata refresh path', async () => {
        const fallback = { ...validFallback, metadata: { ...validFallback.metadata, flavor: null, claudeSessionId: '' } };
        await handlers.get('resume-happy-session')!({ sessionId: 'session-1', fallback });
        expect(resumeSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ fallback }));
    });

    it.each([
        { encryptionKey: 'AQIDBA==' },
        { encryptionKey: '!'.repeat(44) },
        { encryptionKey: Buffer.alloc(33).toString('base64') },
        { encryptionVariant: 'legacy' },
        { seq: -1 },
        { metadata: { ...validFallback.metadata, claudeSessionId: {} } },
        { metadata: { ...validFallback.metadata, codexThreadId: 123 } },
        { metadata: { ...validFallback.metadata, flavor: [] } },
        { metadata: { ...validFallback.metadata, machineId: 'another-machine' } },
        { metadata: { ...validFallback.metadata, machineId: undefined } },
    ])('drops invalid fallback case %# and preserves the tracked path', async (invalid) => {
        const result = await handlers.get('resume-happy-session')!({
            sessionId: 'session-1', fallback: { ...validFallback, ...invalid },
        });
        expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(resumeSession).toHaveBeenCalledWith('session-1', expect.objectContaining({ fallback: undefined }));
    });

    it('accepts old clients without fallback and bounds the diagnostic reason', async () => {
        await handlers.get('resume-happy-session')!({ sessionId: 'session-1', fallbackReason: 'x'.repeat(100) });
        expect(resumeSession).toHaveBeenCalledWith('session-1', {
            model: undefined, permissionMode: undefined, fallback: undefined, fallbackReason: 'x'.repeat(64),
        });
    });

    it.each(['dataKey', 'legacy'] as const)('keeps the fallback inside the %s machine RPC envelope', async (encryptionVariant) => {
        const { RpcHandlerManager } = await vi.importActual<typeof import('./rpc/RpcHandlerManager')>('./rpc/RpcHandlerManager');
        const machineKey = new Uint8Array(32).fill(2);
        const log = vi.fn();
        const manager = new RpcHandlerManager({ scopePrefix: 'test-machine-id', encryptionKey: machineKey, encryptionVariant, logger: log });
        manager.registerHandler('resume-happy-session', handlers.get('resume-happy-session')!);
        const params = encodeBase64(encrypt(machineKey, encryptionVariant, { sessionId: 'session-1', fallback: validFallback }));
        const response = await manager.handleRequest({ method: 'test-machine-id:resume-happy-session', params });
        expect(decrypt(machineKey, encryptionVariant, decodeBase64(response))).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(params.includes(validFallback.encryptionKey)).toBe(false);
        expect(JSON.stringify(log.mock.calls).includes(validFallback.encryptionKey)).toBe(false);
        expect(decrypt(new Uint8Array(32).fill(3), encryptionVariant, decodeBase64(params))).toBeNull();

        resumeSession.mockResolvedValueOnce({ type: 'error', errorMessage: 'No session key' });
        const failedResponse = await manager.handleRequest({ method: 'test-machine-id:resume-happy-session', params });
        expect(decrypt(machineKey, encryptionVariant, decodeBase64(failedResponse))).toEqual({ error: 'No session key' });

        resumeSession.mockClear();
        await manager.handleRequest({ method: 'other-machine:resume-happy-session', params });
        const tampered = decodeBase64(params);
        tampered[tampered.length - 1] ^= 1;
        await manager.handleRequest({ method: 'test-machine-id:resume-happy-session', params: encodeBase64(tampered) });
        expect(resumeSession).not.toHaveBeenCalled();
    });
});
