import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createSessionMetadata: vi.fn(),
    getOrCreateMachine: vi.fn(),
    getOrCreateSession: vi.fn(),
    readSettings: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    execSync: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateMachine: mocks.getOrCreateMachine,
            getOrCreateSession: mocks.getOrCreateSession,
        })),
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: mocks.readSettings,
}));

vi.mock('@/daemon/run', () => ({
    initialMachineMetadata: {},
}));

vi.mock('@/utils/createSessionMetadata', () => ({
    createSessionMetadata: mocks.createSessionMetadata,
}));

import { runCodex } from './runCodex';

describe('runCodex', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.HAPPY_RECONNECT_SESSION_ID;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
        delete process.env.HAPPY_RECONNECT_SEQ;
        delete process.env.HAPPY_RECONNECT_METADATA_VERSION;
        delete process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;
        mocks.readSettings.mockResolvedValue({ machineId: 'machine-1' });
        mocks.getOrCreateMachine.mockResolvedValue(undefined);
        mocks.createSessionMetadata.mockReturnValue({
            state: { controlledByUser: false },
            metadata: {
                path: '/tmp/project',
                host: 'host',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/tmp/lib',
                happyToolsDir: '/tmp/tools',
            },
        });
        mocks.getOrCreateSession.mockRejectedValue(new Error('stop after session creation'));
    });

    it('includes an explicit Codex launch model in initial session metadata', async () => {
        await expect(runCodex({
            credentials: { token: 'token' } as any,
            model: 'gpt-5.6-sol',
        })).rejects.toThrow('stop after session creation');

        expect(mocks.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ currentModelCode: 'gpt-5.6-sol' }),
        }));
        const metadata = mocks.getOrCreateSession.mock.calls[0][0].metadata;
        expect(metadata.models).toBeUndefined();
        expect(metadata.currentModelCode).toBe('gpt-5.6-sol');
    });

    it('does not publish a default model when no launch model was supplied', async () => {
        await expect(runCodex({
            credentials: { token: 'token' } as any,
        })).rejects.toThrow('stop after session creation');

        const metadata = mocks.getOrCreateSession.mock.calls[0][0].metadata;
        expect(metadata.models).toBeUndefined();
        expect(metadata.currentModelCode).toBeUndefined();
    });
});
