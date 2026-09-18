import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagePlanMode } from './messagePlanMode';

const mocks = vi.hoisted(() => ({
    state: { sessions: {}, sessionMessages: {}, currentViewingSessionId: null } as any,
    request: vi.fn(),
    applyMessages: vi.fn(),
    applyMessagesLoaded: vi.fn(),
    applyOlderMessagesPagination: vi.fn(),
    setModes: vi.fn(),
    gitInvalidate: vi.fn(),
    voiceFocus: vi.fn(),
    voiceMessages: vi.fn(),
    voiceReady: vi.fn(),
    loadAvatar: vi.fn(async () => null),
}));

// Exercise the real Sync orchestration, locking and pagination with only the
// native services/network/store boundary replaced. No Expo runtime or sockets.
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: vi.fn() } }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: mocks.request }, getCurrentAppState: () => 'active', getHappyClientId: () => 'test' }));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('@/sync/encryption/artifactEncryption', () => ({ ArtifactEncryption: class {} }));
vi.mock('@/sync/encryption/encryptionCache', () => ({ EncryptionCache: class {} }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({
    ...mocks.state,
    getActiveSessions: () => [],
    applySessions: (sessions: any[]) => {
        mocks.state.sessions = { ...mocks.state.sessions };
        for (const session of sessions) mocks.state.sessions[session.id] = session;
    },
    applyMessages: mocks.applyMessages,
    applyMessagesLoaded: mocks.applyMessagesLoaded,
    applyOlderMessagesPagination: mocks.applyOlderMessagesPagination,
    applyOlderMessagesLoading: (id: string, isLoading: boolean) => {
        if (mocks.state.sessionMessages[id]) mocks.state.sessionMessages[id].isLoadingOlder = isLoading;
    },
    deleteSession: (id: string) => {
        delete mocks.state.sessions[id];
        delete mocks.state.sessionMessages[id];
    },
}) } }));
vi.mock('@/sync/ops', () => ({ sessionSetAgentModes: mocks.setModes }));
vi.mock('@/sync/persistence', () => ({ loadPendingSettings: () => ({}), savePendingSettings: vi.fn() }));
vi.mock('@/sync/revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://example.invalid' }));
vi.mock('@/sync/pushRegistration', () => ({ syncCurrentPushToken: vi.fn() }));
vi.mock('@/sync/apiArtifacts', () => ({ fetchArtifact: vi.fn(), fetchArtifacts: vi.fn(), createArtifact: vi.fn(), updateArtifact: vi.fn() }));
vi.mock('@/sync/apiFriends', () => ({ getFriendsList: vi.fn(), getUserProfile: vi.fn() }));
vi.mock('@/sync/apiFeed', () => ({ fetchFeed: vi.fn() }));
vi.mock('@/sync/apiAttachments', () => ({ requestAttachmentUpload: vi.fn(), uploadEncryptedBlob: vi.fn() }));
vi.mock('@/sync/apiProjects', () => ({ fetchProjects: vi.fn() }));
vi.mock('@/sync/projects', () => ({ decryptProjectRecord: vi.fn(), loadProjectAvatar: vi.fn() }));
vi.mock('@/sync/sessionAvatars', () => ({ loadSessionAvatar: mocks.loadAvatar }));
vi.mock('@/sync/typesRaw', () => ({ normalizeRawMessage: (_id: string, _localId: string, _time: number, content: unknown) => content }));
vi.mock('@/config', () => ({ config: {} }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/track', () => ({ tracking: null }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/encryption/blob', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: () => ({ invalidate: mocks.gitInvalidate }), clearForSession: vi.fn() } }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({ voiceHooks: {
    onSessionFocus: mocks.voiceFocus, onMessages: mocks.voiceMessages, onReady: mocks.voiceReady,
} }));

import { sync } from './sync';

let engine: any;
let encryption: { decryptMessages: ReturnType<typeof vi.fn> };
afterEach(() => { engine?.sessionAvatars.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function response(messages: any[], hasMore = false) {
    return { ok: true, json: async () => ({ messages, hasMore }) };
}
function message(name?: string) {
    return {
        id: 'message', seq: 100, localId: null, createdAt: 1,
        content: { role: 'agent', content: name ? [{ type: 'tool-call', name }] : [{ type: 'text', text: 'Hello' }] },
    };
}
async function waitForPreload() {
    await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalled());
    await Promise.resolve();
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.state = {
        sessions: { a: { id: 'a', permissionMode: 'auto', metadata: {} }, b: { id: 'b', permissionMode: 'auto', metadata: {} } },
        sessionMessages: {}, currentViewingSessionId: null,
    };
    mocks.request.mockResolvedValue(response([message()]));
    mocks.applyMessages.mockImplementation((id, messages, source) => {
        mocks.state.sessionMessages[id] = { messages, messagesMap: { message: messages[0] }, hasMoreOlder: false };
        const enteredPlanMode = messagePlanMode(messages) === true;
        if (enteredPlanMode && source !== 'preload') mocks.state.sessions[id].permissionMode = 'plan';
        return { changed: ['message'], hasReadyEvent: true, enteredPlanMode };
    });
    mocks.applyOlderMessagesPagination.mockImplementation((id, { hasMore }) => {
        mocks.state.sessionMessages[id] ??= {};
        mocks.state.sessionMessages[id].hasMoreOlder = hasMore;
    });
    mocks.setModes.mockImplementation((id, patch) => Object.assign(mocks.state.sessions[id], patch));
    engine = new (sync.constructor as new () => typeof sync)();
    encryption = { decryptMessages: vi.fn(async (messages: any[]) => messages) };
    engine.encryption = { getSessionEncryption: (id: string) => mocks.state.sessions[id] ? encryption : undefined };
});

describe('background history budget', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        engine.historyPrefetchSessions.add('a');
        mocks.request.mockImplementation(async (url: string) => {
            const query = new URL(url, 'https://example.invalid').searchParams;
            if (query.has('after_seq')) return response([]);
            const end = Math.min(Number(query.get('before_seq')) - 1, 10000);
            const page = Array.from({ length: Math.min(100, end) }, (_, index) => ({
                ...message(), id: `m${end - index}`, seq: end - index,
            }));
            return response(page, end > 100);
        });
        mocks.applyMessages.mockImplementation((id, messages) => {
            const previous = mocks.state.sessionMessages[id]?.messagesMap ?? {};
            const messagesMap = { ...previous, ...Object.fromEntries(messages.map((m: any) => [m.id, m])) };
            mocks.state.sessionMessages[id] = { ...mocks.state.sessionMessages[id], messagesMap };
            return { changed: [], hasReadyEvent: false, enteredPlanMode: false };
        });
        // Preserve IDs in this fixture's normalized payload (the boundary mock
        // returns content directly) so duplicate/missing pages are observable.
        encryption.decryptMessages.mockImplementation(async (messages: any[]) => messages.map(m => ({
            ...m, content: { ...m.content, id: m.id },
        })));
    });

    async function openHistory() {
        await engine.fetchMessages('a');
        await vi.runAllTimersAsync();
    }

    it('shares five attempts across visits, reconnects and gap invalidations', async () => {
        await openHistory();
        expect(Object.keys(mocks.state.sessionMessages.a.messagesMap)).toHaveLength(600);
        expect(engine.sessionOldestSeq.get('a')).toBe(9401);
        for (let i = 0; i < 20; i++) {
            // The same invalidation entry point used by reconnect/gap handling;
            // visibility also re-adds history eligibility on every visit.
            engine.historyPrefetchSessions.add('a');
            await engine.getMessagesSync('a').invalidateAndAwait();
            await vi.runAllTimersAsync();
        }
        expect(mocks.request.mock.calls.filter(([url]) => url.includes('before_seq='))).toHaveLength(6);
        expect(engine.sessionOldestSeq.get('a')).toBe(9401);
        expect(mocks.state.sessionMessages.a.hasMoreOlder).toBe(true);
    });

    it('keeps every older page reachable with a continuous exclusive cursor', async () => {
        await openHistory();
        while (mocks.state.sessionMessages.a.hasMoreOlder) await engine.loadOlderMessages('a');
        expect(Object.keys(mocks.state.sessionMessages.a.messagesMap)).toHaveLength(10000);
        expect(engine.sessionOldestSeq.get('a')).toBe(1);
        const cursors = mocks.request.mock.calls.slice(1).map(([url]) => Number(new URL(url, 'https://example.invalid').searchParams.get('before_seq')));
        expect(cursors).toEqual(Array.from({ length: 99 }, (_, i) => 9901 - i * 100));
        expect(engine.sessionLastSeq.get('a')).toBe(10000);
    });

    it('does not multiply the budget for concurrent triggers or replenish it after manual loading', async () => {
        await engine.fetchInitialLatestPage('a', encryption);
        const pending = Promise.all(Array.from({ length: 20 }, () => engine.prefetchOlderMessagesInBackground('a')));
        await vi.runAllTimersAsync();
        await pending;
        expect(mocks.request).toHaveBeenCalledTimes(6);
        await engine.loadOlderMessages('a');
        await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(7);
        expect(engine.sessionOldestSeq.get('a')).toBe(9301);
    });

    it('bounds retries after failures while allowing on-demand recovery', async () => {
        await engine.fetchInitialLatestPage('a', encryption);
        const requestPage = mocks.request.getMockImplementation()!;
        mocks.request.mockRejectedValue(new Error('synthetic offline'));
        for (let i = 0; i < 20; i++) await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(6);
        expect(engine.sessionOldestSeq.get('a')).toBe(9901);
        mocks.request.mockImplementation(requestPage);
        await engine.loadOlderMessages('a');
        expect(engine.sessionOldestSeq.get('a')).toBe(9801);
    });

    it('stops between pages when history is unloaded or its key disappears', async () => {
        await engine.fetchInitialLatestPage('a', encryption);
        delete mocks.state.sessionMessages.a;
        await engine.prefetchOlderMessagesInBackground('a');
        mocks.state.sessionMessages.a = { hasMoreOlder: true };
        engine.encryption.getSessionEncryption = () => undefined;
        await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(engine.olderMessagesPrefetchAttempts.has('a')).toBe(false);
    });

    it('clears the budget together with deleted history and cursors', async () => {
        await openHistory();
        engine.encryption.removeSessionEncryption = vi.fn();
        engine.projectsSync = { invalidate: vi.fn() };
        await engine.handleUpdate({ id: 'delete', seq: 1, createdAt: 1, body: { t: 'delete-session', sid: 'a' } });
        expect(engine.olderMessagesPrefetchAttempts.has('a')).toBe(false);
        expect(engine.sessionOldestSeq.has('a')).toBe(false);
        expect(mocks.state.sessionMessages.a).toBeUndefined();
        await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(6);
    });
});

describe('session avatar sync integration', () => {
    const avatar = { ref: 'sessions/a/avatar/a.enc', preview: 'opaque', version: 1 };
    const update = (seq: number, value: unknown) => ({ id: `u${seq}`, seq, createdAt: seq, body: { t: 'update-session', id: 'a', avatar: value } });

    it('applies artwork events and prevents reordered updates from undoing removal', async () => {
        engine.projectsSync = { invalidate: vi.fn() };
        await engine.handleUpdate(update(10, avatar));
        expect(mocks.state.sessions.a.avatarDescriptor).toEqual(avatar);
        await engine.handleUpdate(update(12, null));
        await engine.handleUpdate(update(11, { ...avatar, version: 2 }));
        expect(mocks.state.sessions.a.avatarDescriptor).toBeNull();
        expect(mocks.state.sessions.a.avatar).toBeNull();
        expect(mocks.state.sessions.a.avatarUpdateSeq).toBe(12);
        expect(mocks.state.sessions.a.seq).toBe(12);
    });

    it('does not resurrect an image when an old event arrives after a removal snapshot', async () => {
        engine.projectsSync = { invalidate: vi.fn() };
        engine.credentials = { token: 'test', secret: 'secret' };
        engine.encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => ({ decryptMetadata: async () => ({}), decryptAgentState: async () => null }),
        };
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [{ id: 'a', seq: 0, metadata: 'opaque', metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, active: false, updatedAt: 10, createdAt: 1, avatar: null, avatarVersion: 3 }] })));
        await engine.fetchSessions();
        await engine.handleUpdate({ ...update(100, { ...avatar, version: 2 }), body: { t: 'update-session', id: 'a', avatar: { ...avatar, version: 2 }, avatarVersion: 2 } });
        expect(mocks.state.sessions.a.avatarDescriptor).toBeNull();
        expect(mocks.state.sessions.a.avatarRevision).toBe(3);
    });

    it('preserves a removal delivered while a stale session snapshot is downloading', async () => {
        engine.projectsSync = { invalidate: vi.fn() };
        engine.credentials = { token: 'test', secret: 'secret' };
        engine.encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => ({ decryptMetadata: async () => ({}), decryptAgentState: async () => null }),
        };
        await engine.handleUpdate(update(10, avatar));
        let finish!: (value: Response) => void;
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
        const fetching = engine.fetchSessions();
        await engine.handleUpdate(update(11, null));
        finish(Response.json({ sessions: [{ id: 'a', seq: 0, metadata: 'opaque', metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, active: false, updatedAt: 1, createdAt: 1, avatar }] }));
        await fetching;
        expect(mocks.state.sessions.a.avatarDescriptor).toBeNull();
        expect(mocks.state.sessions.a.avatarUpdateSeq).toBe(11);
    });
});

describe('chat preload sync integration', () => {
    it('hydrates one latest page without read, voice, git, or history side effects', async () => {
        mocks.request.mockResolvedValue(response([message()], true));
        const older = vi.spyOn(engine, 'loadOlderMessages');
        engine.preloadSession('a');
        await waitForPreload();
        expect(mocks.request).toHaveBeenCalledOnce();
        expect(mocks.request.mock.calls[0][0]).toBe('/v3/sessions/a/messages?before_seq=2147483647&limit=100');
        expect(mocks.applyMessages.mock.calls[0][2]).toBe('preload');
        expect(mocks.state.currentViewingSessionId).toBeNull();
        expect(mocks.voiceFocus).not.toHaveBeenCalled();
        expect(mocks.voiceMessages).not.toHaveBeenCalled();
        expect(mocks.voiceReady).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(older).not.toHaveBeenCalled();
        engine.preloadSession('a');
        await Promise.resolve();
        expect(mocks.request).toHaveBeenCalledOnce();
    });

    it('shares the in-flight first page with touch-up and activates it normally', async () => {
        let finish!: (value: unknown) => void;
        mocks.request.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        engine.preloadSession('a');
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
        mocks.state.currentViewingSessionId = 'a';
        engine.onSessionVisible('a');
        finish(response([message()]));
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.request).toHaveBeenCalledOnce();
        expect(encryption.decryptMessages).toHaveBeenCalledOnce();
        expect(mocks.applyMessages.mock.calls[0][2]).toBe('sync');
        expect(mocks.voiceMessages).toHaveBeenCalledOnce();
        expect(mocks.voiceFocus).toHaveBeenCalledWith('a', {});
    });

    it('revalidates a completed preload and starts older history only after a visit', async () => {
        mocks.request.mockResolvedValueOnce(response([message()], true)).mockResolvedValue(response([]));
        // End this test's history loop after its first attempt, without timers.
        const older = vi.spyOn(engine, 'loadOlderMessages').mockRejectedValue(new Error('test stop'));
        engine.preloadSession('a');
        await waitForPreload();
        expect(older).not.toHaveBeenCalled();
        mocks.state.currentViewingSessionId = 'a';
        engine.onSessionVisible('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.request.mock.calls[1][0]).toBe('/v3/sessions/a/messages?after_seq=100&limit=100');
        expect(older).toHaveBeenCalledExactlyOnceWith('a');
    });

    it('defers plan-mode changes until the session is actually opened, exactly once', async () => {
        mocks.request.mockResolvedValueOnce(response([message('EnterPlanMode')])).mockResolvedValue(response([]));
        engine.preloadSession('a');
        await waitForPreload();
        expect(mocks.state.sessions.a.permissionMode).toBe('auto');
        expect(mocks.setModes).not.toHaveBeenCalled();
        engine.onSessionVisible('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.setModes).toHaveBeenCalledExactlyOnceWith('a', { permissionMode: 'plan' });
        expect(mocks.state.sessions.a.permissionMode).toBe('plan');
    });

    it.each(['new-choice', 'exit-event', 'exit-on-refresh'])('does not replay an obsolete plan transition: %s', async (reason) => {
        mocks.request.mockResolvedValueOnce(response([message('EnterPlanMode')])).mockResolvedValue(response([]));
        engine.preloadSession('a');
        await waitForPreload();
        if (reason === 'new-choice') mocks.state.sessions.a.permissionMode = 'yolo';
        else if (reason === 'exit-event') engine.applyMessages('a', [message('ExitPlanMode').content]);
        else mocks.request.mockResolvedValue(response([{ ...message('ExitPlanMode'), seq: 101 }]));
        engine.onSessionVisible('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.setModes).not.toHaveBeenCalled();
    });

    it('drops an abandoned page even if the transport ignores abort', async () => {
        let finish!: (value: unknown) => void;
        mocks.request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(response([message()]));
        engine.preloadSession('a');
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
        engine.preloadSession('b');
        expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
        finish(response([message()]));
        await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalledWith('b'));
        expect(mocks.applyMessagesLoaded).not.toHaveBeenCalledWith('a');
        expect(engine.sessionLastSeq.has('a')).toBe(false);
    });

    it('does not hydrate after the session is deleted during decryption', async () => {
        let finish!: (value: unknown) => void;
        encryption.decryptMessages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        engine.preloadSession('a');
        await vi.waitFor(() => expect(encryption.decryptMessages).toHaveBeenCalledOnce());
        const pending = engine.messagePreloader.take('a');
        delete mocks.state.sessions.a;
        finish([message()]);
        await expect(pending).resolves.toBe(false);
        expect(mocks.applyMessages).not.toHaveBeenCalled();
        expect(engine.sessionLastSeq.has('a')).toBe(false);
    });

    it('server events preserve voice-follow without claiming a visit or fetching all history', async () => {
        mocks.request.mockResolvedValue(response([message()], true));
        const older = vi.spyOn(engine, 'loadOlderMessages');
        engine.onSessionDataUpdated('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.voiceFocus).toHaveBeenCalledWith('a', {});
        expect(mocks.state.currentViewingSessionId).toBeNull();
        expect(older).not.toHaveBeenCalled();
    });
});