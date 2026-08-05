import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bulkArchiveSessions, bulkDeleteSessions } from './bulkSessionActions';
import type { Session } from '@/sync/storageTypes';

const mocks = vi.hoisted(() => ({
    deleteLocalSession: vi.fn(),
    sessionArchive: vi.fn(),
    sessionDelete: vi.fn(),
    sessionKill: vi.fn(),
    sessionRequestArchiveMetadata: vi.fn(),
}));

vi.mock('@/sync/ops', () => ({
    sessionArchive: mocks.sessionArchive,
    sessionDelete: mocks.sessionDelete,
    sessionKill: mocks.sessionKill,
    sessionRequestArchiveMetadata: mocks.sessionRequestArchiveMetadata,
}));

vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            deleteSession: mocks.deleteLocalSession,
        }),
    },
}));

function session(overrides: Partial<Session>): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        presence: 1,
        ...overrides,
    };
}

describe('bulkSessionActions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.deleteLocalSession.mockReset();
        mocks.sessionKill.mockResolvedValue({ success: true });
        mocks.sessionArchive.mockResolvedValue({ success: true });
        mocks.sessionDelete.mockResolvedValue({ success: true });
    });

    it('archives each selected session and falls back to server archive when kill fails', async () => {
        mocks.sessionKill
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false });

        await bulkArchiveSessions([
            session({ id: 'a', active: true }),
            session({ id: 'b', active: true }),
        ]);

        expect(mocks.sessionKill).toHaveBeenCalledWith('a');
        expect(mocks.sessionKill).toHaveBeenCalledWith('b');
        expect(mocks.sessionArchive).toHaveBeenCalledWith('b');
    });

    it('kills active sessions before deleting them', async () => {
        await bulkDeleteSessions([
            session({ id: 'active', active: true, presence: 'online' }),
            session({ id: 'archived', active: false, presence: 123 }),
        ]);

        expect(mocks.sessionKill).toHaveBeenCalledTimes(1);
        expect(mocks.sessionKill).toHaveBeenCalledWith('active');
        expect(mocks.sessionDelete).toHaveBeenCalledWith('active');
        expect(mocks.sessionDelete).toHaveBeenCalledWith('archived');
        expect(mocks.deleteLocalSession).toHaveBeenCalledWith('active');
        expect(mocks.deleteLocalSession).toHaveBeenCalledWith('archived');
    });
});
