import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execSync: vi.fn(),
    getOrCreateMachine: vi.fn(),
    getOrCreateSession: vi.fn(),
    notifyDaemonSessionStarted: vi.fn(),
    readSettings: vi.fn(),
    launchNativeCodex: vi.fn(),
    reconnectionCancel: vi.fn(),
    session: {
        onUserMessage: vi.fn(),
        keepAlive: vi.fn(),
        updateAgentState: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
    },
}));

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execSync: mocks.execSync,
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateMachine: mocks.getOrCreateMachine,
            getOrCreateSession: mocks.getOrCreateSession,
        })),
    },
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/persistence')>()),
    readSettings: mocks.readSettings,
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mocks.notifyDaemonSessionStarted,
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
    setupOfflineReconnection: vi.fn(() => ({
        session: mocks.session,
        reconnectionHandle: { cancel: mocks.reconnectionCancel },
    })),
}));

vi.mock('./codexLocalLauncher', () => ({
    launchNativeCodex: mocks.launchNativeCodex,
}));

import { runCodex } from './runCodex';

describe('runCodex local start', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readSettings.mockResolvedValue({ machineId: 'machine-1' });
        mocks.getOrCreateSession.mockResolvedValue({
            id: 'happy-session-1',
            seq: 1,
            encryptionKey: new Uint8Array([1, 2, 3]),
            encryptionVariant: 'legacy',
            metadata: {},
            metadataVersion: 1,
            agentState: {},
            agentStateVersion: 1,
        });
        mocks.notifyDaemonSessionStarted.mockResolvedValue({});
        mocks.launchNativeCodex.mockResolvedValue({ type: 'exit', code: 4 });
        mocks.session.updateAgentState.mockImplementation((updater) => updater({}));
        mocks.session.flush.mockResolvedValue(undefined);
        mocks.session.close.mockResolvedValue(undefined);
    });

    it('launches native Codex and exits with its code for terminal local mode', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`exit:${code}`);
        }) as never);

        await expect(runCodex({
            credentials: { token: 'token' } as never,
            startedBy: 'terminal',
            startingMode: 'local',
            resumeThreadId: 'thread-123',
            startupModel: 'gpt-5.5',
            startupEffort: 'medium',
            startupPermissionMode: 'yolo',
        })).rejects.toThrow('exit:4');

        expect(mocks.session.keepAlive).toHaveBeenCalledWith(false, 'local');
        expect(mocks.session.updateAgentState).toHaveBeenCalled();
        expect(mocks.launchNativeCodex).toHaveBeenCalledWith({
            cwd: process.cwd(),
            codexThreadId: 'thread-123',
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
        });
        expect(mocks.session.sendSessionDeath).toHaveBeenCalled();
        expect(mocks.session.flush).toHaveBeenCalled();
        expect(mocks.session.close).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(4);

        exit.mockRestore();
    });
});
