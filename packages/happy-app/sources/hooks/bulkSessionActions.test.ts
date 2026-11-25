import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkSessionActionError, bulkArchiveSessions, bulkDeleteSessions, resolveSessionsForBulkAction } from './bulkSessionActions';
import type { Session } from '@/sync/storageTypes';
import { t } from '@/text';

const mocks = vi.hoisted(() => ({
    deleteLocalSession: vi.fn(),
    sessionArchive: vi.fn(),
    sessionDelete: vi.fn(),
    sessionKill: vi.fn(),
    sessionRequestArchiveMetadata: vi.fn(),
    sessions: {} as Record<string, Session>,
    refreshConversationSession: vi.fn(),
    hydrate: vi.fn(),
    sessionUpdateMetadata: vi.fn(),
}));

vi.mock('@/sync/ops', () => ({
    sessionArchive: mocks.sessionArchive,
    sessionDelete: mocks.sessionDelete,
    sessionKill: mocks.sessionKill,
    sessionRequestArchiveMetadata: mocks.sessionRequestArchiveMetadata,
    sessionUpdateMetadata: mocks.sessionUpdateMetadata,
}));

vi.mock('@/sync/sync', () => ({ sync: { removeSessionLocally: mocks.deleteLocalSession, refreshConversationSession: mocks.refreshConversationSession } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: mocks.sessions,
    applySessions: (sessions: Session[]) => { for (const session of sessions) mocks.sessions[session.id] = session; },
}) } }));
vi.mock('@/sync/ensureSessionHydratedWithRetry', () => ({ ensureSessionHydratedWithRetry: mocks.hydrate }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

function session(overrides: Partial<Session>): Session {
    const value = {
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
    mocks.sessions[value.id] = value;
    return value;
}

describe('bulkSessionActions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.deleteLocalSession.mockReset();
        mocks.sessions = {};
        mocks.refreshConversationSession.mockImplementation(async id => !!mocks.sessions[id]);
        mocks.hydrate.mockImplementation(async id => !!mocks.sessions[id]);
        mocks.sessionUpdateMetadata.mockImplementation(async (id, metadata, version, update) => ({ metadata: update(mocks.sessions[id]?.metadata ?? metadata), version: version + 1 }));
        mocks.sessionKill.mockResolvedValue({ success: true });
        mocks.sessionArchive.mockResolvedValue({ success: true });
        mocks.sessionDelete.mockResolvedValue({ success: true });
    });

    const metadata = { path: '/repo', host: 'test', machineId: 'machine' };
    function sharedChat() {
        const root = session({ id: 'root', metadata: { ...metadata, conversationActiveSessionId: 'current' } });
        const old = session({ id: 'old', metadata: { ...metadata, conversationRootSessionId: 'root', continuationOfSessionId: 'root' } });
        const current = session({ id: 'current', metadata: { ...metadata, conversationRootSessionId: 'root', continuationOfSessionId: 'old' } });
        mocks.sessions = { root, old, current };
        return { root, old, current };
    }

    it('deletes all segments once, keeping the current worker and root until earlier history succeeds', async () => {
        const { root, current } = sharedChat();
        await bulkDeleteSessions([root, current]);
        expect(mocks.refreshConversationSession).toHaveBeenCalledWith('root');
        expect(mocks.sessionDelete.mock.calls.map(([id]) => id)).toEqual(['old', 'current', 'root']);
        expect(mocks.deleteLocalSession.mock.calls.map(([id]) => id)).toEqual(['old', 'current', 'root']);
    });

    it('archives the complete chat and leaves a separately created continuation independent', async () => {
        const { root } = sharedChat();
        const separate = session({ id: 'separate', metadata: { ...metadata, continuationOfSessionId: 'root' } });
        mocks.sessions.separate = separate;
        await bulkArchiveSessions([root, separate]);
        expect(mocks.sessionRequestArchiveMetadata.mock.calls.map(([item]) => item.id)).toEqual(['old', 'current', 'root', 'separate']);
    });

    it('loads an unavailable middle segment before allowing any deletion', async () => {
        const { root, old } = sharedChat();
        delete mocks.sessions.old;
        mocks.hydrate.mockImplementation(async id => { if (id === 'old') mocks.sessions.old = old; return !!mocks.sessions[id]; });
        expect((await resolveSessionsForBulkAction([root])).map(item => item.id)).toEqual(['old', 'current', 'root']);
        expect(mocks.hydrate).toHaveBeenCalledWith('old');
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
    });

    it('refuses a missing segment or corrupt membership before mutating any session', async () => {
        const { root } = sharedChat();
        delete mocks.sessions.old;
        await expect(bulkDeleteSessions([root])).rejects.toThrow(t('session.conversationActionUnavailable'));
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
        sharedChat();
        mocks.sessions.current.metadata!.conversationRootSessionId = 'foreign';
        await expect(bulkArchiveSessions([mocks.sessions.root])).rejects.toThrow(t('session.conversationActionUnavailable'));
        expect(mocks.sessionRequestArchiveMetadata).not.toHaveBeenCalled();
    });

    it('refuses every pending switch and a fresh pointer change during history preparation', async () => {
        const { root } = sharedChat();
        root.metadata!.conversationSwitch = { id: 'switch', sourceSessionId: 'old', targetSessionId: 'current' };
        await expect(bulkDeleteSessions([root])).rejects.toThrow(t('session.agentSwitchPending'));
        sharedChat();
        mocks.refreshConversationSession.mockImplementation(async id => {
            if (id === 'current') mocks.sessions.root = { ...mocks.sessions.root, metadata: { ...mocks.sessions.root.metadata!, conversationActiveSessionId: 'elsewhere' } };
            return !!mocks.sessions[id];
        });
        await expect(bulkDeleteSessions([mocks.sessions.root])).rejects.toThrow(t('session.conversationActionUnavailable'));
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
    });

    it('reports a partial deletion and preserves the active worker and root when historical deletion fails', async () => {
        const { root, old, current } = sharedChat();
        const older = session({ id: 'older', metadata: { ...metadata, conversationRootSessionId: 'root', continuationOfSessionId: 'root' } });
        old.metadata!.continuationOfSessionId = 'older';
        mocks.sessions.older = older;
        mocks.sessionDelete.mockImplementation(async id => ({ success: id !== 'old', message: 'synthetic rejection' }));
        let failure: unknown;
        try { await bulkDeleteSessions([root]); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(BulkSessionActionError);
        expect(failure).toMatchObject({ completedIds: ['older'], failedSessionId: 'old', pendingIds: ['current', 'root'] });
        expect(mocks.sessionDelete.mock.calls.map(([id]) => id)).toEqual(['older', 'old']);
        expect(mocks.deleteLocalSession).toHaveBeenCalledExactlyOnceWith('older');
        expect(mocks.sessions.current).toBe(current);
        expect(mocks.sessions.root).toMatchObject({ id: root.id, metadata: { conversationDeletePlan: { completedSessionIds: ['older'], activeSessionId: 'current' } } });
    });

    it('saves the complete encrypted deletion plan before deleting any segment', async () => {
        const { root } = sharedChat();
        await bulkDeleteSessions([root]);
        expect(mocks.sessionUpdateMetadata.mock.invocationCallOrder[0]).toBeLessThan(mocks.sessionDelete.mock.invocationCallOrder[0]);
        expect(mocks.sessionUpdateMetadata.mock.calls[0][3](root.metadata)).toMatchObject({ conversationDeletePlan: {
            sessionIds: ['old', 'current', 'root'], completedSessionIds: [], activeSessionId: 'current',
        } });
    });

    it('retries a saved plan after reload even when successful earlier deletions broke the original chain', async () => {
        const { root } = sharedChat();
        mocks.deleteLocalSession.mockImplementation(id => { delete mocks.sessions[id]; });
        mocks.sessionDelete.mockImplementation(async id => ({ success: id !== 'current', message: 'synthetic rejection' }));
        await expect(bulkDeleteSessions([root])).rejects.toMatchObject({ completedIds: ['old'], failedSessionId: 'current', pendingIds: ['root'] });
        expect(mocks.sessions.old).toBeUndefined();
        const reloadedRoot = JSON.parse(JSON.stringify(mocks.sessions.root));
        mocks.sessions.root = reloadedRoot;
        mocks.sessionDelete.mockClear();
        mocks.sessionDelete.mockResolvedValue({ success: true });
        await bulkDeleteSessions([reloadedRoot]);
        expect(mocks.sessionDelete.mock.calls.map(([id]) => id)).toEqual(['current', 'root']);
        expect(mocks.sessions.root).toBeUndefined();
    });

    it('repeats only a planned deletion if deletion succeeded but its completion receipt was lost', async () => {
        const { root } = sharedChat();
        mocks.deleteLocalSession.mockImplementation(id => { delete mocks.sessions[id]; });
        const save = mocks.sessionUpdateMetadata.getMockImplementation()!;
        let writes = 0;
        mocks.sessionUpdateMetadata.mockImplementation(async (...args) => {
            if (++writes === 2) throw new Error('synthetic receipt outage');
            return save(...args);
        });
        await expect(bulkDeleteSessions([root])).rejects.toMatchObject({ completedIds: ['old'], failedSessionId: 'old' });
        expect(mocks.sessions.old).toBeUndefined();
        expect(mocks.sessions.root.metadata?.conversationDeletePlan?.completedSessionIds).toEqual([]);
        mocks.sessionUpdateMetadata.mockImplementation(save);
        mocks.sessionDelete.mockClear();
        // The real sessionDelete operation treats an already deleted planned ID (404) as success.
        mocks.sessionDelete.mockResolvedValue({ success: true });
        await bulkDeleteSessions([mocks.sessions.root]);
        expect(mocks.sessionDelete.mock.calls.map(([id]) => id)).toEqual(['old', 'current', 'root']);
    });

    it('can finish deleting the stable root after its active execution is already gone', async () => {
        const { root } = sharedChat();
        mocks.deleteLocalSession.mockImplementation(id => { delete mocks.sessions[id]; });
        mocks.sessionDelete.mockImplementation(async id => ({ success: id !== 'root', message: 'synthetic rejection' }));
        await expect(bulkDeleteSessions([root])).rejects.toMatchObject({ completedIds: ['old', 'current'], failedSessionId: 'root', pendingIds: [] });
        expect(mocks.sessions.current).toBeUndefined();
        mocks.sessionDelete.mockClear();
        mocks.sessionDelete.mockResolvedValue({ success: true });
        await bulkDeleteSessions([mocks.sessions.root]);
        expect(mocks.sessionDelete).toHaveBeenCalledExactlyOnceWith('root');
    });

    it('does not delete when CAS observes a newer active execution before the plan is committed', async () => {
        const { root } = sharedChat();
        mocks.sessionUpdateMetadata.mockImplementation(async (_id, metadata, version, update) => ({
            metadata: update({ ...metadata, conversationActiveSessionId: 'newer' }), version: version + 1,
        }));
        await expect(bulkDeleteSessions([root])).rejects.toThrow(t('session.conversationDeleteStateChanged'));
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
    });

    it('refuses inconsistent saved plans and does not archive a chat whose deletion is pending', async () => {
        const { root } = sharedChat();
        root.metadata!.conversationDeletePlan = { sessionIds: ['old', 'current', 'root'], completedSessionIds: ['foreign'], activeSessionId: 'current' };
        await expect(bulkDeleteSessions([root])).rejects.toThrow(t('session.conversationDeletePlanInvalid'));
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
        await expect(bulkArchiveSessions([root])).rejects.toThrow(t('session.conversationDeletePending'));
        expect(mocks.sessionRequestArchiveMetadata).not.toHaveBeenCalled();
    });

    it('archives each selected session and falls back to server archive when kill fails', async () => {
        mocks.sessionKill
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false });

        await bulkArchiveSessions([
            session({ id: 'a', active: true, presence: 'online', metadata }),
            session({ id: 'b', active: true, presence: 'online', metadata }),
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
    it.each(['archive', 'delete'] as const)('refreshes a stale ungrouped source before %s and handles the full conversation', async action => {
        const cached = session({ id: 'root', metadata });
        const fresh = { ...cached, metadata: { ...metadata, conversationActiveSessionId: 'current' } };
        const current = session({ id: 'current', metadata: { ...metadata, conversationRootSessionId: 'root', continuationOfSessionId: 'root' } });
        mocks.refreshConversationSession.mockImplementation(async id => {
            if (id === 'root') mocks.sessions.root = fresh;
            return !!mocks.sessions[id];
        });
        if (action === 'delete') {
            await bulkDeleteSessions([cached]);
            expect(mocks.sessionDelete.mock.calls.map(([id]) => id)).toEqual(['current', 'root']);
        } else {
            await bulkArchiveSessions([cached]);
            expect(mocks.sessionRequestArchiveMetadata.mock.calls.map(([value]) => value.id)).toEqual(['current', 'root']);
        }
    });

    it.each([
        ['current', 'archive'], ['old', 'archive'], ['current', 'delete'], ['old', 'delete'],
    ] as const)('uses the committed root when legacy %s membership is missing during %s', async (sourceId, action) => {
        const { root, old, current } = sharedChat();
        mocks.sessions.old = { ...old, metadata: { ...old.metadata!, conversationRootSessionId: undefined } };
        mocks.sessions.current = { ...current, metadata: { ...current.metadata!, conversationRootSessionId: undefined } };
        const source = mocks.sessions[sourceId];
        if (action === 'delete') {
            await bulkDeleteSessions([source]);
            expect(mocks.sessionDelete.mock.calls.map(([id]) => id)).toEqual(['old', 'current', root.id]);
        } else {
            await bulkArchiveSessions([source]);
            expect(mocks.sessionRequestArchiveMetadata.mock.calls.map(([value]) => value.id)).toEqual(['old', 'current', root.id]);
        }
        expect(mocks.refreshConversationSession).toHaveBeenCalledWith(root.id);
    });

    it('keeps an independent new-session continuation deletable after its predecessor is deleted', async () => {
        const separate = session({ id: 'independent', metadata: { ...metadata, continuationOfSessionId: 'deleted-source' } });
        await bulkDeleteSessions([separate]);
        expect(mocks.sessionDelete).toHaveBeenCalledExactlyOnceWith(separate.id);
        expect(mocks.refreshConversationSession).not.toHaveBeenCalledWith('deleted-source');
    });

    it('does not mistake a stripped committed member with missing history for an independent session', async () => {
        const { current } = sharedChat();
        mocks.sessions.current = { ...current, metadata: { ...current.metadata!, conversationRootSessionId: undefined } };
        delete mocks.sessions.old;
        await expect(bulkDeleteSessions([mocks.sessions.current])).rejects.toThrow(t('session.conversationActionUnavailable'));
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
    });

    it('refuses conflicting root claims instead of acting on a stripped child alone', async () => {
        const { current } = sharedChat();
        mocks.sessions.current = { ...current, metadata: { ...current.metadata!, conversationRootSessionId: undefined } };
        session({ id: 'foreign-root', metadata: { ...metadata, conversationActiveSessionId: current.id } });
        await expect(bulkArchiveSessions([mocks.sessions.current])).rejects.toThrow(t('session.conversationActionUnavailable'));
        expect(mocks.sessionRequestArchiveMetadata).not.toHaveBeenCalled();
    });

    it('resumes a validated deletion plan when a surviving legacy member lost only its membership hint', async () => {
        const { root, current } = sharedChat();
        root.metadata!.conversationDeletePlan = { sessionIds: ['old', current.id, root.id], completedSessionIds: ['old'], activeSessionId: current.id };
        delete mocks.sessions.old;
        mocks.sessions.current = { ...current, metadata: { ...current.metadata!, conversationRootSessionId: undefined } };
        await bulkDeleteSessions([root]);
        expect(mocks.sessionDelete.mock.calls.map(([id]) => id)).toEqual([current.id, root.id]);
    });

    it('does not resume a deletion plan if a surviving member explicitly changed ownership', async () => {
        const { root, current } = sharedChat();
        root.metadata!.conversationDeletePlan = { sessionIds: ['old', current.id, root.id], completedSessionIds: ['old'], activeSessionId: current.id };
        delete mocks.sessions.old;
        mocks.sessions.current = { ...current, metadata: { ...current.metadata!, conversationRootSessionId: 'foreign-root' } };
        await expect(bulkDeleteSessions([root])).rejects.toThrow(t('session.conversationDeletePlanInvalid'));
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
    });

    it('rejects a same-location legacy member reparented after a deletion plan was saved', async () => {
        const { root, current } = sharedChat();
        root.metadata!.conversationDeletePlan = { sessionIds: ['old', current.id, root.id], completedSessionIds: ['old'], activeSessionId: current.id };
        delete mocks.sessions.old;
        mocks.sessions.current = { ...current, metadata: { ...current.metadata!,
            conversationRootSessionId: undefined, continuationOfSessionId: 'different-predecessor',
        } };
        await expect(bulkDeleteSessions([root])).rejects.toThrow(t('session.conversationDeletePlanInvalid'));
        expect(mocks.sessionDelete).not.toHaveBeenCalled();
        expect(mocks.sessionUpdateMetadata).not.toHaveBeenCalled();
    });

});
