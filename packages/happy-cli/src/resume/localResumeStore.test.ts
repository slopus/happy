import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockReadPersistedSessions: vi.fn(),
    mockReadCredentials: vi.fn(),
}));

vi.mock('@/persistence', () => ({
    readPersistedSessions: mocks.mockReadPersistedSessions,
    readCredentials: mocks.mockReadCredentials,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        sessionsFile: '/tmp/.happy/sessions.json',
        serverUrl: 'https://api.example.test',
        currentCliVersion: '1.1.10',
    },
}));

import { LocalResumeSessionError, resolveLocalReconnectableSession } from './localResumeStore';

describe('resolveLocalReconnectableSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mockReadCredentials.mockResolvedValue(null);
    });

    it('resolves a locally persisted dataKey session without agent.key credentials', async () => {
        mocks.mockReadPersistedSessions.mockReturnValue({
            'session-1': {
                encryptionKey: 'AQIDBA==',
                encryptionVariant: 'dataKey',
                seq: 12,
                metadataVersion: 3,
                agentStateVersion: 4,
                metadata: {
                    path: '/tmp/repo',
                    flavor: 'codex',
                    codexThreadId: 'thread-1',
                    host: 'localhost',
                    homeDir: '/tmp',
                    happyHomeDir: '/tmp/.happy',
                    happyLibDir: '/tmp/happy',
                    happyToolsDir: '/tmp/happy/tools',
                },
                savedAt: Date.now(),
            },
        });

        await expect(resolveLocalReconnectableSession('session-1')).resolves.toMatchObject({
            id: 'session-1',
            seq: 12,
            metadataVersion: 3,
            agentStateVersion: 4,
            encryptionVariant: 'dataKey',
            metadata: {
                codexThreadId: 'thread-1',
            },
        });
    });

    it('reports missing local encryption data without suggesting happy-agent auth login', async () => {
        mocks.mockReadPersistedSessions.mockReturnValue({});

        let thrown: unknown;
        try {
            await resolveLocalReconnectableSession('missing');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(LocalResumeSessionError);
        expect((thrown as Error).message).toContain('/tmp/.happy/sessions.json');
        expect((thrown as Error).message).not.toContain('happy-agent auth login');
    });
});
