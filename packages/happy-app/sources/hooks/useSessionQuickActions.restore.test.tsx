import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { useSessionQuickActions } from './useSessionQuickActions';

const mocks = vi.hoisted(() => ({
    connected: false,
    online: true,
    latestSession: undefined as Session | undefined,
    extraSessions: {} as Record<string, Session>,
    restore: vi.fn(),
    resume: vi.fn(),
    refresh: vi.fn(),
    navigate: vi.fn(),
    alert: vi.fn(),
    success: vi.fn(),
    updatePermission: vi.fn(),
    updateModel: vi.fn(),
    updateEffort: vi.fn(),
    updateMetadata: vi.fn(),
    requestArchive: vi.fn(),
    archive: vi.fn(),
    kill: vi.fn(),
    delete: vi.fn(),
    removeLocal: vi.fn(),
    hydrate: vi.fn(),
    refreshConversation: vi.fn(),
    togglePinned: vi.fn(),
    prompt: vi.fn(),
    afterArchive: vi.fn(),
    afterDelete: vi.fn(),
    applySessions: vi.fn(),
    regenerate: vi.fn(),
    regenerateSupported: false,
    ensureMessages: vi.fn(),
    sessionMessages: {} as Record<string, any>,
}));
vi.mock('@/sync/ops', () => ({
    sessionRestoreMetadata: mocks.restore,
    machineResumeSession: mocks.resume,
    sessionUpdateMetadata: mocks.updateMetadata,
    sessionRequestArchiveMetadata: mocks.requestArchive,
    sessionArchive: mocks.archive,
    sessionKill: mocks.kill,
    sessionDelete: mocks.delete,
    sessionRegenerateTitle: mocks.regenerate,
}));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: mocks.refresh, refreshConversationSession: mocks.refreshConversation,
    removeSessionLocally: mocks.removeLocal, ensureMessagesLoaded: mocks.ensureMessages } }));
vi.mock('@/sync/ensureSessionHydratedWithRetry', () => ({ ensureSessionHydratedWithRetry: mocks.hydrate }));
vi.mock('@/sync/storage', () => ({
    useMachine: () => ({ id: 'machine-1', metadata: {} }),
    useSetting: () => false,
    useSession: (id: string) => id === 'original-session' ? mocks.latestSession : mocks.extraSessions[id],
    storage: { getState: () => ({ settings: {},
        sessions: { ...mocks.extraSessions, ...(mocks.latestSession ? { 'original-session': mocks.latestSession } : {}) },
        machines: { 'machine-1': { id: 'machine-1', metadata: {} } },
        updateSessionPermissionMode: mocks.updatePermission,
        updateSessionModelMode: mocks.updateModel,
        updateSessionEffortLevel: mocks.updateEffort,
        applySessions: mocks.applySessions,
        sessionMessages: mocks.sessionMessages,
    }) },
}));
vi.mock('@/utils/sessionUtils', () => ({
    useSessionStatus: () => ({ isConnected: mocks.connected, state: 'idle' }),
    getSessionName: (source: Session) => source.metadata?.summary?.text ?? 'Archived task',
}));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => mocks.online }));
vi.mock('@/sync/messageMeta', () => ({
    resolveMessageModeMeta: () => ({ model: 'gpt-6.1-sol', permissionMode: 'yolo', effort: 'xhigh' }),
}));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/hooks/useWorktreeCleanup', () => ({ maybeCleanupWorktree: vi.fn() }));
vi.mock('@/hooks/useSessionManagementPreferences', () => ({
    useSessionManagementPreferences: () => ({ isPinned: () => false, togglePinned: mocks.togglePinned }),
}));
vi.mock('@/sync/crossAgentContinuation', () => ({ createCrossAgentContinuation: vi.fn() }));
vi.mock('@/sync/sessionContinuation', () => ({ createSessionContinuation: vi.fn() }));
vi.mock('@/utils/copySessionMetadataToClipboard', () => ({}));
vi.mock('@/utils/sessionFork', () => ({ getSessionForkSource: () => null }));
vi.mock('@/utils/sessionTitleRegeneration', () => ({ canRegenerateSessionTitle: () => mocks.regenerateSupported }));
vi.mock('@/utils/messageForkPoint', () => ({}));
vi.mock('@/components/DuplicateSheet', () => ({ DuplicateSheet: () => null }));
vi.mock('@/components/haptics', () => ({ hapticsSuccess: mocks.success }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert, prompt: mocks.prompt } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const session = {
    id: 'original-session', metadataVersion: 4,
    presence: 1,
    metadata: { machineId: 'machine-1', path: '/project', flavor: 'codex',
        codexThreadId: 'original-thread', lifecycleState: 'archived' },
    permissionMode: 'yolo', modelMode: 'gpt-6.1-sol', effortLevel: 'xhigh',
} as Session;

function conversation() {
    const root = { ...session, metadata: { ...session.metadata!,
        summary: { text: 'Shared conversation title', updatedAt: 1 }, conversationActiveSessionId: 'active-segment' } } as Session;
    const history = { ...session, id: 'history-segment', metadata: { ...session.metadata!,
        flavor: 'claude', conversationRootSessionId: root.id, continuationOfSessionId: root.id } } as Session;
    const active = { ...session, id: 'active-segment', metadata: { ...session.metadata!,
        codexThreadId: 'active-native-thread', summary: { text: 'Native segment title', updatedAt: 1 },
        conversationRootSessionId: root.id, continuationOfSessionId: history.id } } as Session;
    const separate = { ...session, id: 'separate-session', metadata: { ...session.metadata!, continuationOfSessionId: active.id } } as Session;
    mocks.latestSession = root;
    mocks.extraSessions = { [history.id]: history, [active.id]: active, [separate.id]: separate };
    return { root, history, active, separate };
}

let renderer: { unmount: () => void };
let actions: ReturnType<typeof useSessionQuickActions>;
function mount(target = session, options: Parameters<typeof useSessionQuickActions>[1] = {}) {
    function Harness() { actions = useSessionQuickActions(target, options); return null; }
    act(() => { renderer = TestRenderer.create(React.createElement(Harness)); });
}
async function restore() {
    await act(async () => { actions.restoreSession(); });
}

describe('restoring archived sessions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.connected = false;
        mocks.online = true;
        mocks.latestSession = session;
        mocks.extraSessions = {};
        mocks.sessionMessages = {};
        mocks.regenerateSupported = false;
        mocks.restore.mockResolvedValue({ version: 5 });
        mocks.resume.mockResolvedValue({ type: 'success', sessionId: session.id });
        mocks.refresh.mockResolvedValue(undefined);
        mocks.refreshConversation.mockResolvedValue(true);
        mocks.hydrate.mockImplementation(async id => id === 'original-session' ? Boolean(mocks.latestSession) : Boolean(mocks.extraSessions[id]));
        mocks.kill.mockResolvedValue({ success: true });
        mocks.archive.mockResolvedValue({ success: true });
        mocks.delete.mockResolvedValue({ success: true });
        mocks.requestArchive.mockResolvedValue(undefined);
        mocks.prompt.mockResolvedValue(null);
        mocks.regenerate.mockResolvedValue({ success: true, title: 'Generated conversation title' });
        mocks.ensureMessages.mockResolvedValue(undefined);
        mocks.updateMetadata.mockImplementation(async (_id, metadata, version, update) => ({ metadata: update(metadata), version: version + 1 }));
        mocks.removeLocal.mockImplementation(id => { if (id === 'original-session') mocks.latestSession = undefined; else delete mocks.extraSessions[id]; });
        mocks.applySessions.mockImplementation((sessions: Session[]) => {
            for (const source of sessions) {
                if (source.id === 'original-session') mocks.latestSession = source;
                else mocks.extraSessions[source.id] = source;
            }
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const original = console.error;
        vi.spyOn(console, 'error').mockImplementation((...args) => {
            if (String(args[0]).startsWith('react-test-renderer is deprecated')) return;
            original(...args);
        });
    });
    afterEach(() => { act(() => renderer?.unmount()); vi.restoreAllMocks(); });

    it('reconnects the original worker before unarchiving can release queued input', async () => {
        mount();
        await restore();
        expect(mocks.resume).toHaveBeenCalledWith({ machineId: 'machine-1', sessionId: 'original-session',
            agent: 'codex', model: 'gpt-6.1-sol', permissionMode: 'yolo', effort: 'xhigh' });
        expect(mocks.resume.mock.invocationCallOrder[0]).toBeLessThan(mocks.restore.mock.invocationCallOrder[0]);
        expect(mocks.navigate).toHaveBeenCalledWith('original-session');
        expect(mocks.updateModel).toHaveBeenCalledWith('original-session', 'gpt-6.1-sol');
        expect(mocks.success).toHaveBeenCalledOnce();
    });

    it('waits for reconnection before announcing restore success', async () => {
        let finish!: (value: unknown) => void;
        mocks.resume.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        mount();
        await restore();
        expect(actions.restoringSession).toBe(true);
        expect(mocks.restore).not.toHaveBeenCalled();
        expect(mocks.success).not.toHaveBeenCalled();
        await act(async () => { finish({ type: 'success', sessionId: session.id }); });
        expect(actions.restoringSession).toBe(false);
        expect(mocks.success).toHaveBeenCalledOnce();
    });

    it('reports resume failure so an unarchived but disconnected chat is not presented as ready', async () => {
        mocks.resume.mockResolvedValue({ type: 'error', errorMessage: 'Original thread unavailable' });
        mount();
        await restore();
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'Original thread unavailable', expect.any(Array));
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it.each(['online-worker', 'offline-machine', 'no-backend-id'] as const)(
        'restores metadata without restarting an unavailable or warm worker: %s', async kind => {
            mocks.connected = kind === 'online-worker';
            mocks.online = kind !== 'offline-machine';
            const target = kind === 'no-backend-id'
                ? { ...session, metadata: { ...session.metadata!, codexThreadId: undefined } }
                : kind === 'online-worker'
                    ? { ...session, presence: 'online' as const, metadata: { ...session.metadata!, lifecycleState: 'running' } }
                    : session;
            mocks.latestSession = target;
            mount(target);
            await restore();
            expect(mocks.restore).toHaveBeenCalledOnce();
            expect(mocks.refresh).toHaveBeenCalled();
            expect(mocks.resume).not.toHaveBeenCalled();
        },
    );

    it('reports a metadata conflict after reconnection without reporting restore success', async () => {
        mocks.restore.mockRejectedValue(new Error('Version conflict'));
        mount();
        await restore();
        expect(mocks.resume).toHaveBeenCalledOnce();
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalled();
    });

    it('preserves a worker that reconnected while the restore was refreshing', async () => {
        mocks.refresh.mockImplementationOnce(async () => {
            mocks.latestSession = { ...session, presence: 'online', thinking: true,
                metadata: { ...session.metadata!, lifecycleState: 'running' } };
        });
        mount();
        await restore();
        expect(mocks.resume).not.toHaveBeenCalled();
        expect(mocks.success).toHaveBeenCalledOnce();
    });

    it('resumes an explicitly archived worker even when the old presence still says online', async () => {
        const target = { ...session, presence: 'online' as const };
        mocks.latestSession = target;
        mount(target);
        await restore();
        expect(mocks.resume).toHaveBeenCalledOnce();
        expect(mocks.resume.mock.invocationCallOrder[0]).toBeLessThan(mocks.restore.mock.invocationCallOrder[0]);
    });

    it('restores from the refreshed worker metadata after reconnecting', async () => {
        mocks.resume.mockImplementationOnce(async () => {
            mocks.latestSession = { ...session, metadataVersion: 9, presence: 'online',
                metadata: { ...session.metadata!, hostPid: 321, lifecycleState: 'running' } };
            return { type: 'success', sessionId: session.id };
        });
        mount();
        await restore();
        expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({ metadataVersion: 9,
            metadata: expect.objectContaining({ hostPid: 321 }) }));
    });

    it('does not resume if the machine went offline during the metadata restore', async () => {
        mocks.refresh.mockImplementationOnce(async () => { mocks.online = false; });
        mount();
        await restore();
        expect(mocks.resume).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalled();
    });

    it('pins and manually renames the root when invoked from an execution segment', async () => {
        const { root, active } = conversation();
        mount(active);
        act(() => actions.togglePinSession());
        expect(mocks.togglePinned).toHaveBeenCalledExactlyOnceWith(root.id);
        await act(async () => actions.renameSessionToTitle('A new shared title'));
        expect(mocks.updateMetadata).toHaveBeenCalledExactlyOnceWith(root.id, root.metadata,
            root.metadataVersion, expect.any(Function));
        await expect(mocks.updateMetadata.mock.results[0].value).resolves.toMatchObject({ metadata: {
            summary: { text: 'A new shared title' }, conversationActiveSessionId: active.id,
        } });
    });

    it('prompts with the root title and renames from current root metadata after the prompt', async () => {
        const { root, active } = conversation();
        let finish!: (title: string) => void;
        mocks.prompt.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        mount(active);
        await act(async () => actions.renameSession());
        expect(mocks.prompt).toHaveBeenCalledWith('sessionInfo.renameSession', 'sessionInfo.renameSessionPrompt',
            expect.objectContaining({ defaultValue: 'Shared conversation title' }));
        mocks.latestSession = { ...root, metadataVersion: 9 };
        await act(async () => finish('Renamed after waiting'));
        expect(mocks.updateMetadata).toHaveBeenCalledWith(root.id, root.metadata, 9, expect.any(Function));
    });

    it('resumes the active execution segment and navigates to the stable root', async () => {
        const { root, active } = conversation();
        mocks.resume.mockResolvedValueOnce({ type: 'success', sessionId: active.id });
        mount(root);
        await act(async () => actions.resumeSession());
        expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: active.id, agent: 'codex' }));
        expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(root.id);
        expect(mocks.updateModel).toHaveBeenCalledWith(active.id, 'gpt-6.1-sol');
    });

    it('generates a title on the current worker and applies the result to the logical root', async () => {
        const { root, active } = conversation();
        mocks.connected = true;
        mocks.regenerateSupported = true;
        mocks.sessionMessages = { [active.id]: { messages: [{ kind: 'user-text', text: 'Continue saved work', createdAt: 1 }] } };
        mount(root);
        await act(async () => actions.regenerateTitle());
        expect(mocks.regenerate).toHaveBeenCalledExactlyOnceWith(active.id,
            expect.objectContaining({ currentTitle: 'Shared conversation title', transcript: 'User: Continue saved work' }));
        expect(mocks.updateMetadata).toHaveBeenCalledWith(root.id, root.metadata, root.metadataVersion, expect.any(Function));
        await expect(mocks.updateMetadata.mock.results[0].value).resolves.toMatchObject({ metadata: {
            summary: { text: 'Generated conversation title' },
        } });
    });

    it('archives the complete conversation before reporting completion and leaves a separate continuation alone', async () => {
        const { root, history, active, separate } = conversation();
        mount(active, { onAfterArchive: mocks.afterArchive });
        await act(async () => actions.archiveSession());
        expect(mocks.requestArchive.mock.calls.map(([source]) => source.id)).toEqual([history.id, active.id, root.id]);
        expect(mocks.requestArchive).not.toHaveBeenCalledWith(separate);
        expect(mocks.afterArchive).toHaveBeenCalledOnce();
        expect(actions.groupActionFailure).toBeNull();
    });

    it('deletes history and active execution before the root without deleting a separate continuation', async () => {
        const { root, history, active, separate } = conversation();
        mount(root, { onAfterDelete: mocks.afterDelete });
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.delete.mock.calls.map(([id]) => id)).toEqual([history.id, active.id, root.id]);
        expect(mocks.removeLocal.mock.calls.map(([id]) => id)).toEqual([history.id, active.id, root.id]);
        expect(mocks.extraSessions[separate.id]).toBe(separate);
        expect(mocks.afterDelete).toHaveBeenCalledOnce();
    });

    it('reports a partial deletion and retains the root when a later segment fails', async () => {
        const { root, history, active } = conversation();
        mocks.delete.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, message: 'Delete denied' });
        mount(active, { onAfterDelete: mocks.afterDelete });
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.delete.mock.calls.map(([id]) => id)).toEqual([history.id, active.id]);
        expect(mocks.latestSession?.id).toBe(root.id);
        expect(mocks.afterDelete).not.toHaveBeenCalled();
        expect(actions.groupActionFailure).toMatchObject({ action: 'delete', completedIds: [history.id],
            failedSessionId: active.id, pendingIds: [root.id] });
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'session.conversationDeletePartial', expect.any(Array));
    });

    it('retries a partial deletion from its persisted plan without needing deleted history', async () => {
        const { root, history, active } = conversation();
        mocks.delete.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, message: 'Delete denied' });
        mount(root, { onAfterDelete: mocks.afterDelete });
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.latestSession?.metadata?.conversationDeletePlan).toMatchObject({
            sessionIds: [history.id, active.id, root.id], completedSessionIds: [history.id], activeSessionId: active.id,
        });
        expect(mocks.extraSessions[history.id]).toBeUndefined();
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.delete.mock.calls.map(([id]) => id)).toEqual([history.id, active.id, active.id, root.id]);
        expect(mocks.afterDelete).toHaveBeenCalledOnce();
        expect(actions.groupActionFailure).toBeNull();
    });

    it('exposes deletion recovery when the active segment disappeared after a validated plan was saved', async () => {
        const { root, history, active } = conversation();
        mocks.latestSession = { ...root, metadata: { ...root.metadata!, conversationDeletePlan: {
            sessionIds: [history.id, active.id, root.id], completedSessionIds: [history.id], activeSessionId: active.id,
        } } };
        delete mocks.extraSessions[history.id];
        delete mocks.extraSessions[active.id];
        mount(mocks.latestSession, { onAfterDelete: mocks.afterDelete });
        expect(actions.canRetryConversationDelete).toBe(true);
        expect(actions.canResume).toBe(false);
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.delete.mock.calls.map(([id]) => id)).toEqual([active.id, root.id]);
        expect(mocks.afterDelete).toHaveBeenCalledOnce();
    });

    it('does not report a whole-conversation archive after one segment fails', async () => {
        const { root, history, active } = conversation();
        mocks.requestArchive.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Archive conflict'));
        mount(root, { onAfterArchive: mocks.afterArchive });
        await act(async () => actions.archiveSession());
        expect(mocks.requestArchive.mock.calls.map(([source]) => source.id)).toEqual([history.id, active.id]);
        expect(mocks.afterArchive).not.toHaveBeenCalled();
        expect(actions.groupActionFailure).toMatchObject({ action: 'archive', completedIds: [history.id],
            failedSessionId: active.id, pendingIds: [root.id] });
    });

    it.each(['missing-history', 'pending-switch'])('performs no group mutation when validation rejects %s', async reason => {
        const { root, history, active } = conversation();
        if (reason === 'missing-history') delete mocks.extraSessions[history.id];
        else mocks.latestSession = { ...root, metadata: { ...root.metadata!,
            conversationSwitch: { id: 'switch', sourceSessionId: active.id, targetSessionId: 'candidate' } } };
        mount(active, { onAfterDelete: mocks.afterDelete });
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.delete).not.toHaveBeenCalled();
        expect(mocks.removeLocal).not.toHaveBeenCalled();
        expect(mocks.afterDelete).not.toHaveBeenCalled();
        expect(actions.groupActionFailure).toMatchObject({ action: 'delete', completedIds: [], failedSessionId: null });
    });

    it('keeps an explicit new-session continuation independent during deletion', async () => {
        const { root, active, separate } = conversation();
        mount(separate, { onAfterDelete: mocks.afterDelete });
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.delete).toHaveBeenCalledExactlyOnceWith(separate.id);
        expect(mocks.latestSession).toBe(root);
        expect(mocks.extraSessions[active.id]).toBe(active);
        expect(mocks.afterDelete).toHaveBeenCalledOnce();
    });

    it('restores every archived segment after resuming only the active execution', async () => {
        const { root, history, active } = conversation();
        mocks.resume.mockResolvedValueOnce({ type: 'success', sessionId: active.id });
        mount(root);
        await restore();
        expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: active.id }));
        expect(mocks.restore.mock.calls.map(([source]) => source.id)).toEqual([history.id, active.id, root.id]);
        expect(mocks.success).toHaveBeenCalledOnce();
    });

    it.each(['archive', 'delete', 'restore'] as const)(
        'refreshes authority before %s when an old render predates the first Agent switch', async action => {
            const { root, history, active } = conversation();
            const stale = { ...root, metadata: { ...root.metadata!, conversationActiveSessionId: undefined } };
            mocks.latestSession = stale;
            mocks.resume.mockResolvedValue({ type: 'success', sessionId: active.id });
            mocks.refreshConversation.mockImplementation(async id => {
                if (id === root.id && !mocks.latestSession?.metadata?.conversationActiveSessionId) mocks.latestSession = root;
                return id === root.id ? Boolean(mocks.latestSession) : Boolean(mocks.extraSessions[id]);
            });
            mount(stale, { onAfterArchive: mocks.afterArchive, onAfterDelete: mocks.afterDelete });
            expect(mocks.refreshConversation).not.toHaveBeenCalled();
            await act(async () => {
                if (action === 'archive') actions.archiveSession();
                else if (action === 'delete') actions.confirmDeleteSession();
                else actions.restoreSession();
            });
            const expected = [history.id, active.id, root.id];
            if (action === 'archive') expect(mocks.requestArchive.mock.calls.map(([source]) => source.id)).toEqual(expected);
            else if (action === 'delete') expect(mocks.delete.mock.calls.map(([id]) => id)).toEqual(expected);
            else {
                expect(mocks.restore.mock.calls.map(([source]) => source.id)).toEqual(expected);
                expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: active.id }));
            }
            expect(mocks.refreshConversation).toHaveBeenCalledWith(root.id);
        },
    );

    it.each(['archive', 'delete', 'restore'] as const)(
        'does not %s from cached metadata when the source authority is unreadable or deleted', async action => {
            mocks.refreshConversation.mockResolvedValue(false);
            mount(session);
            await act(async () => {
                if (action === 'archive') actions.archiveSession();
                else if (action === 'delete') actions.confirmDeleteSession();
                else actions.restoreSession();
            });
            expect(mocks.requestArchive).not.toHaveBeenCalled();
            expect(mocks.delete).not.toHaveBeenCalled();
            expect(mocks.restore).not.toHaveBeenCalled();
            expect(mocks.resume).not.toHaveBeenCalled();
            expect(actions.groupActionFailure).toMatchObject({ action, completedIds: [], failedSessionId: null });
            expect(mocks.alert).toHaveBeenCalledWith('common.error', 'session.conversationActionUnavailable', expect.any(Array));
        },
    );

    it('refuses a lifecycle action if the fresh source no longer belongs to the confirmed root', async () => {
        mocks.refreshConversation.mockImplementationOnce(async () => {
            mocks.latestSession = { ...session, metadata: { ...session.metadata!, conversationRootSessionId: 'different-root' } };
            return true;
        });
        mount(session);
        await act(async () => actions.confirmDeleteSession());
        expect(mocks.delete).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'session.agentSwitchChanged', expect.any(Array));
    });

    it.each([
        ['active', 'archive'], ['history', 'archive'], ['active', 'delete'], ['history', 'delete'],
        ['active', 'restore'], ['history', 'restore'],
    ] as const)('keeps stripped %s membership bound to the committed root during %s', async (sourceKind, action) => {
        const { root, history, active } = conversation();
        mocks.extraSessions[history.id] = { ...history, metadata: { ...history.metadata!, conversationRootSessionId: undefined } };
        mocks.extraSessions[active.id] = { ...active, metadata: { ...active.metadata!, conversationRootSessionId: undefined } };
        const source = mocks.extraSessions[sourceKind === 'active' ? active.id : history.id];
        mocks.resume.mockResolvedValue({ type: 'success', sessionId: active.id });
        mount(source);
        await act(async () => {
            if (action === 'archive') actions.archiveSession();
            else if (action === 'delete') actions.confirmDeleteSession();
            else actions.restoreSession();
        });
        const expected = [history.id, active.id, root.id];
        if (action === 'archive') expect(mocks.requestArchive.mock.calls.map(([member]) => member.id)).toEqual(expected);
        else if (action === 'delete') expect(mocks.delete.mock.calls.map(([id]) => id)).toEqual(expected);
        else {
            expect(mocks.restore.mock.calls.map(([member]) => member.id)).toEqual(expected);
            expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: active.id }));
            expect(mocks.navigate).toHaveBeenCalledWith(root.id);
        }
    });
});
