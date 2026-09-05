import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiMessage, ApiSessionSnapshot } from './apiTypes';
import type { HydratedSession } from './sessionSnapshotHydration';
import { SessionMessageLoadGate } from './sessionMessageLoadGate';
import { SessionMessageRetention } from './sessionMessageRetention';

vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    (globalThis as unknown as { expo?: { EventEmitter: unknown } }).expo = {
        EventEmitter: EventTarget,
    };
});

const mocks = vi.hoisted(() => {
    const state = {
        sessions: {} as Record<string, HydratedSession>,
        sessionMessages: {} as Record<string, any>,
        currentViewingSessionId: null as string | null,
        settings: { expImageUpload: false },
        mutableToolCalls: new Set<string>(),
        getActiveSessions: () => Object.values(state.sessions).filter((session) => session.active),
        applySessions: (sessions: HydratedSession[], options?: { replace?: boolean }) => {
            if (options?.replace) state.sessions = {};
            for (const session of sessions) state.sessions[session.id] = session;
        },
        applyMessages: (sessionId: string, messages: any[]) => {
            const existing = state.sessionMessages[sessionId] ?? {
                messages: [],
                messagesMap: {},
                reducerState: {},
                isLoaded: false,
                hasMoreOlder: false,
                isLoadingOlder: false,
            };
            const messagesMap = { ...existing.messagesMap };
            for (const message of messages) messagesMap[message.id] = message;
            state.sessionMessages[sessionId] = {
                ...existing,
                messagesMap,
                messages: Object.values(messagesMap),
                isLoaded: true,
            };
            return { changed: messages.map((message) => message.id), hasReadyEvent: false };
        },
        applyMessagesLoaded: (sessionId: string) => {
            state.sessionMessages[sessionId] = {
                ...(state.sessionMessages[sessionId] ?? {
                    messages: [],
                    messagesMap: {},
                    reducerState: {},
                    hasMoreOlder: false,
                    isLoadingOlder: false,
                }),
                isLoaded: true,
            };
        },
        applyOlderMessagesPagination: (sessionId: string, info: { hasMore: boolean }) => {
            const existing = state.sessionMessages[sessionId];
            if (existing) existing.hasMoreOlder = info.hasMore;
        },
        applyOlderMessagesLoading: (sessionId: string, loading: boolean) => {
            const existing = state.sessionMessages[sessionId];
            if (existing) existing.isLoadingOlder = loading;
        },
        isMutableToolCall: (sessionId: string, callId: string) => (
            state.mutableToolCalls.has(`${sessionId}:${callId}`)
        ),
    };
    const storage = {
        getState: () => state,
        setState: (update: any) => {
            const next = typeof update === 'function' ? update(state) : update;
            Object.assign(state, next);
        },
    };
    return {
        apiRequest: vi.fn(),
        fetchActive: vi.fn(),
        fetchPage: vi.fn(),
        fetchSnapshot: vi.fn(),
        hydrate: vi.fn(),
        hydrateRoute: vi.fn(),
        sessionEncryptions: new Map<string, any>(),
        gitInvalidate: vi.fn(),
        gitOpenInvalidate: vi.fn(),
        gitClear: vi.fn(),
        state,
        storage,
    };
});

vi.mock('./apiSessions', () => ({
    fetchActiveSessionSnapshots: mocks.fetchActive,
    fetchSessionSnapshot: mocks.fetchSnapshot,
    fetchSessionSnapshotPage: mocks.fetchPage,
}));
vi.mock('./sessionSnapshotHydration', () => ({
    hydrateSessionSnapshotForRoute: mocks.hydrateRoute,
    hydrateSessionSnapshots: mocks.hydrate,
}));
vi.mock('./storage', () => ({ storage: mocks.storage }));
vi.mock('./apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onReconnected: vi.fn(),
        request: mocks.apiRequest,
        sendAppState: vi.fn(),
    },
    getCurrentAppState: vi.fn(() => 'active'),
    getHappyClientId: vi.fn(() => 'test-client'),
}));
vi.mock('./gitStatusSync', () => ({
    gitStatusSync: {
        invalidate: mocks.gitInvalidate,
        getSync: vi.fn(() => ({ invalidate: mocks.gitOpenInvalidate })),
        clearForSession: mocks.gitClear,
    },
}));
vi.mock('./pushRegistration', () => ({ syncCurrentPushToken: vi.fn() }));
vi.mock('./encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('./revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('./uploadMediaFile', () => ({ uploadMediaFile: vi.fn() }));
vi.mock('./uploadAttachmentForSession', () => ({ uploadAttachmentForSession: vi.fn() }));
vi.mock('./apiAttachments', () => ({ requestAttachmentUpload: vi.fn(), uploadEncryptedBlob: vi.fn() }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: vi.fn() }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: false }));
vi.mock('@/config', () => ({ config: {} }));
vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    trackGitHubConnected: vi.fn(),
    trackMessageSent: vi.fn(),
    tracking: null,
    trackPaywallCancelled: vi.fn(),
    trackPaywallError: vi.fn(),
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallRestored: vi.fn(),
}));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({
    voiceHooks: {
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onPermissionRequested: vi.fn(),
        onMessages: vi.fn(),
        onReady: vi.fn(),
        onSessionFocus: vi.fn(),
    },
}));
vi.mock('react-native', () => ({
    AppState: { currentState: 'active', addEventListener: vi.fn() },
    Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn(() => 'test-uuid') }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

import { sync } from './sync';

const syncForTest = sync as any;

function snapshot(id: string, seq = 3): ApiSessionSnapshot {
    return {
        id,
        seq,
        metadata: `metadata-${id}`,
        metadataVersion: seq,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: `key-${id}`,
        active: true,
        activeAt: seq * 10,
        createdAt: 10,
        updatedAt: seq * 10,
    };
}

function hydrated(raw: ApiSessionSnapshot): HydratedSession {
    return {
        ...raw,
        metadata: { path: `/${raw.id}`, host: 'test', name: raw.metadata } as any,
        agentState: null,
        thinking: false,
        thinkingAt: 0,
    };
}

function response(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

function rawText(text: string) {
    return { role: 'user', content: { type: 'text', text } } as const;
}

function rawToolResult(uuid: string) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                uuid,
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
                },
            },
        },
    } as const;
}

function apiMessage(seq: number, content: unknown = 'ciphertext'): ApiMessage {
    return {
        id: `message-${seq}`,
        seq,
        localId: null,
        content: { t: 'encrypted', c: String(content) },
        createdAt: seq * 10,
        updatedAt: seq * 10,
    };
}

function newMessageUpdate(sessionId: string, seq: number) {
    return {
        id: `update-${sessionId}-${seq}`,
        seq,
        createdAt: seq * 10,
        body: {
            t: 'new-message',
            sid: sessionId,
            message: apiMessage(seq),
        },
    };
}

function installSession(sessionId: string, decryptMessages?: (messages: ApiMessage[]) => Promise<any[]>) {
    mocks.state.sessions[sessionId] = hydrated(snapshot(sessionId));
    const encryption: any = {
        createDetached() { return this; },
        decryptMessage: vi.fn(async (message: ApiMessage) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawText(`realtime-${message.seq}`),
        })),
        decryptMessages: vi.fn(decryptMessages ?? (async (messages: ApiMessage[]) => messages.map((message) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawText(`fetched-${message.seq}`),
        })))),
        decryptAgentState: vi.fn(async () => ({ controlledByUser: false, requests: {} })),
        decryptMetadata: vi.fn(async () => ({ name: sessionId })),
    };
    mocks.sessionEncryptions.set(sessionId, encryption);
    return encryption;
}

describe('message visibility synchronization', () => {
    beforeEach(() => {
        syncForTest.sessionEventCursors.clear();
        syncForTest.sessionHydrations.clear();
        syncForTest.inFlightSessionRefreshes.clear();
        syncForTest.sessionDeletionMutationGenerations.clear();
        vi.clearAllMocks();
        mocks.state.sessions = {};
        mocks.state.sessionMessages = {};
        mocks.state.currentViewingSessionId = null;
        mocks.state.mutableToolCalls.clear();
        mocks.sessionEncryptions.clear();
        mocks.apiRequest.mockResolvedValue(response({ messages: [], hasMore: false }));
        mocks.fetchSnapshot.mockResolvedValue(null);
        mocks.hydrate.mockImplementation(async (items: ApiSessionSnapshot[]) => items.map(hydrated));
        mocks.hydrateRoute.mockImplementation(async (raw: ApiSessionSnapshot) => ({
            session: hydrated(raw),
            commitEncryption: () => true,
        }));
        syncForTest.credentials = { token: 'test-token', secret: 'test-secret' };
        syncForTest.encryption = {
            getSessionEncryption: vi.fn((id: string) => mocks.sessionEncryptions.get(id) ?? null),
            removeSessionEncryption: vi.fn(),
        };
        syncForTest.messagesSync = new Map();
        syncForTest.sessionLastSeq = new Map();
        syncForTest.sessionOldestSeq = new Map();
        syncForTest.sessionMessageLocks = new Map();
        syncForTest.sessionMessageQueue = new Map();
        syncForTest.sessionQueueProcessing = new Set();
        syncForTest.sessionOlderLoadingTokens = new Map();
        syncForTest.sessionMessageCacheGenerations = new Map();
        syncForTest.sessionMessageLoadGate = new SessionMessageLoadGate();
        syncForTest.sessionMessageRetention = new SessionMessageRetention(3);
        syncForTest.activeOpenSession = null;
    });

    afterEach(() => {
        for (const messageSync of syncForTest.messagesSync.values()) {
            messageSync.stop();
        }
    });

    it('does not fetch messages or git for an off-screen new-message event', async () => {
        installSession('visible-session');
        installSession('background-session');
        mocks.state.currentViewingSessionId = 'visible-session';

        await syncForTest.handleUpdate(newMessageUpdate('background-session', 8));
        await Promise.resolve();

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(mocks.gitOpenInvalidate).not.toHaveBeenCalled();
        expect(mocks.state.sessions['background-session']).toMatchObject({ updatedAt: 80, seq: 8 });
    });

    it('appends a consecutive visible message without an HTTP refresh', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        syncForTest.sessionLastSeq.set('visible-session', 4);

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 5));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-5']).toBeDefined();
        });

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(5);
    });

    it('fills one sequence gap only for the visible session', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        syncForTest.sessionLastSeq.set('visible-session', 4);
        mocks.apiRequest.mockResolvedValue(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-7']).toBeDefined();
        });

        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.apiRequest).toHaveBeenCalledWith(
            '/v3/sessions/visible-session/messages?after_seq=4&limit=100',
        );
    });

    it('coalesces concurrent visible gaps into one forward operation', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        syncForTest.sessionLastSeq.set('visible-session', 4);
        const firstPage = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(firstPage.promise)
            .mockResolvedValue(response({ messages: [], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 8));
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);

        firstPage.resolve(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7), apiMessage(8)],
            hasMore: false,
        }));
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
    });

    it('runs one follow-up forward operation when an in-flight response misses a newer gap target', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        syncForTest.sessionLastSeq.set('visible-session', 4);
        const firstPage = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(firstPage.promise)
            .mockResolvedValueOnce(response({ messages: [apiMessage(8)], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 8));
        firstPage.resolve(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));

        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
        expect(mocks.apiRequest).toHaveBeenNthCalledWith(
            2,
            '/v3/sessions/visible-session/messages?after_seq=7&limit=100',
        );
        expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-8']).toBeDefined();
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
    });

    it.each([
        ['equal duplicate', 8],
        ['lower out-of-order', 7],
    ])('ignores a visible %s without history or git refresh', async (_label, incomingSeq) => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        syncForTest.sessionLastSeq.set('visible-session', 8);

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', incomingSeq));
        await Promise.resolve();

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
        expect(mocks.state.sessionMessages['visible-session']).toBeUndefined();
    });

    it('keeps the newest realtime anchor when an older forward page returns later', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        syncForTest.sessionLastSeq.set('visible-session', 4);
        const page = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(page.promise)
            .mockResolvedValue(response({ messages: [], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 5));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 6));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        page.resolve(response({ messages: [apiMessage(5)], hasMore: false }));
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 8));
        await Promise.resolve();

        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
    });

    it('does not fill a background gap and releases only its message cache', async () => {
        installSession('visible-session');
        const backgroundEncryption = installSession('background-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.sessionMessages['background-session'] = {
            messages: [{ id: 'cached' }],
            messagesMap: { cached: { id: 'cached' } },
            isLoaded: true,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
        syncForTest.sessionLastSeq.set('background-session', 4);
        syncForTest.sessionOldestSeq.set('background-session', 2);

        await syncForTest.handleUpdate(newMessageUpdate('background-session', 7));
        await Promise.resolve();

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.state.sessionMessages['background-session']).toBeUndefined();
        expect(syncForTest.getSessionLastMessageSeq('background-session')).toBeNull();
        expect(syncForTest.sessionOldestSeq.has('background-session')).toBe(false);
        expect(mocks.state.sessions['background-session']).toBeDefined();
        expect(syncForTest.encryption.getSessionEncryption('background-session')).toBe(backgroundEncryption);
    });

    it('refreshes git for a mutable tool result only while its session is visible', async () => {
        const visibleEncryption = installSession('visible-session');
        const backgroundEncryption = installSession('background-session');
        visibleEncryption.decryptMessage.mockImplementation(async (message: ApiMessage) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawToolResult('uuid-visible-session'),
        }));
        backgroundEncryption.decryptMessage.mockImplementation(async (message: ApiMessage) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawToolResult('uuid-background-session'),
        }));
        mocks.state.mutableToolCalls.add('visible-session:call-1');
        mocks.state.mutableToolCalls.add('background-session:call-1');
        syncForTest.sessionLastSeq.set('visible-session', 4);
        syncForTest.sessionLastSeq.set('background-session', 4);
        mocks.state.currentViewingSessionId = 'visible-session';

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 5));
        await syncForTest.handleUpdate(newMessageUpdate('background-session', 5));

        expect(mocks.gitInvalidate).toHaveBeenCalledTimes(1);
        expect(mocks.gitInvalidate).toHaveBeenCalledWith('visible-session');
    });

    it('refreshes git once when a visible gap contains a fetched mutable tool result', async () => {
        installSession('visible-session', async (messages) => messages.map((message) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: message.seq === 5 ? rawToolResult('uuid-gap-tool') : rawText(`fetched-${message.seq}`),
        })));
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.mutableToolCalls.add('visible-session:call-1');
        syncForTest.sessionLastSeq.set('visible-session', 4);
        mocks.apiRequest.mockResolvedValue(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-7']).toBeDefined();
        });

        expect(mocks.gitInvalidate).toHaveBeenCalledTimes(1);
        expect(mocks.gitInvalidate).toHaveBeenCalledWith('visible-session');
    });

    it('refreshes git once when a later forward page fails after a mutable page was applied', async () => {
        installSession('visible-session', async (messages) => messages.map((message) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawToolResult(`uuid-partial-${message.seq}`),
        })));
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.mutableToolCalls.add('visible-session:call-1');
        syncForTest.sessionLastSeq.set('visible-session', 4);
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: [apiMessage(5)], hasMore: true }))
            .mockRejectedValueOnce(new Error('second page unavailable'));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        const messageSync = syncForTest.messagesSync.get('visible-session');
        try {
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));

            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-5']).toBeDefined();
            expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(5);
            expect(mocks.gitInvalidate).toHaveBeenCalledTimes(1);
        } finally {
            syncForTest.releaseSessionMessageCache('visible-session');
            await messageSync.awaitQueue();
        }
    });

    it('does not refresh git for an agent-state update without message tool-result semantics', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';

        await syncForTest.handleUpdate({
            id: 'agent-state-update',
            seq: 8,
            createdAt: 80,
            body: {
                t: 'update-session',
                id: 'visible-session',
                metadata: null,
                agentState: { version: 8, value: 'agent-state-ciphertext' },
            },
        });

        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
    });

    it('refreshes git when the user explicitly opens a session', () => {
        installSession('visible-session');

        syncForTest.onSessionVisible('visible-session', { loadMessages: false });

        expect(mocks.gitOpenInvalidate).toHaveBeenCalledTimes(1);
    });

    it('evicts exactly the least recently viewed message cache and all of its message runtime', () => {
        installSession('session-a');
        const evictedEncryption = installSession('session-b');
        installSession('session-c');
        installSession('session-d');
        for (const sessionId of ['session-a', 'session-b', 'session-c', 'session-d']) {
            mocks.state.sessionMessages[sessionId] = { messages: [], messagesMap: {}, isLoaded: true };
            syncForTest.sessionLastSeq.set(sessionId, 9);
            syncForTest.sessionOldestSeq.set(sessionId, 2);
            syncForTest.sessionMessageLocks.set(sessionId, {});
            syncForTest.sessionMessageQueue.set(sessionId, []);
        }
        const evictedLease = syncForTest.sessionMessageLoadGate.enter('session-b');
        const evictedOperation = syncForTest.sessionMessageLoadGate.begin(evictedLease);
        const evictedSync = { stop: vi.fn() };
        syncForTest.messagesSync.set('session-b', evictedSync);
        syncForTest.sessionQueueProcessing.add('session-b');

        syncForTest.onSessionVisible('session-a', { loadMessages: false });
        syncForTest.onSessionVisible('session-b', { loadMessages: false });
        syncForTest.onSessionVisible('session-c', { loadMessages: false });
        syncForTest.onSessionVisible('session-a', { loadMessages: false });
        syncForTest.onSessionVisible('session-d', { loadMessages: false });

        expect(mocks.state.sessionMessages['session-b']).toBeUndefined();
        expect(syncForTest.sessionLastSeq.has('session-b')).toBe(false);
        expect(syncForTest.sessionOldestSeq.has('session-b')).toBe(false);
        expect(syncForTest.sessionMessageLocks.has('session-b')).toBe(false);
        expect(syncForTest.sessionMessageQueue.has('session-b')).toBe(false);
        expect(syncForTest.sessionQueueProcessing.has('session-b')).toBe(false);
        expect(syncForTest.messagesSync.has('session-b')).toBe(false);
        expect(evictedSync.stop).toHaveBeenCalledTimes(1);
        expect(mocks.state.sessionMessages['session-a']).toBeDefined();
        expect(mocks.state.sessionMessages['session-c']).toBeDefined();
        expect(mocks.state.sessionMessages['session-d']).toBeDefined();
        expect(mocks.state.sessions['session-b']).toBeDefined();
        expect(syncForTest.encryption.getSessionEncryption('session-b')).toBe(evictedEncryption);
        expect(syncForTest.sessionMessageLoadGate.isCurrent(evictedOperation)).toBe(false);
    });

    it('ignores an initial response invalidated while message decryption is in flight', async () => {
        const decrypted = deferred<any[]>();
        const encryption = installSession('stale-session', async () => decrypted.promise);
        mocks.state.currentViewingSessionId = 'stale-session';
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(9)], hasMore: true }));

        const loading = syncForTest.ensureMessagesLoaded('stale-session');
        await vi.waitFor(() => expect(encryption.decryptMessages).toHaveBeenCalledTimes(1));
        syncForTest.releaseSessionMessageCache('stale-session');
        decrypted.resolve([{
            id: 'message-9',
            localId: null,
            createdAt: 90,
            content: rawText('stale'),
        }]);
        await loading;
        await Promise.resolve();

        expect(mocks.state.sessionMessages['stale-session']).toBeUndefined();
        expect(syncForTest.getSessionLastMessageSeq('stale-session')).toBeNull();
        expect(syncForTest.sessionOldestSeq.has('stale-session')).toBe(false);
    });

    it('invalidates a route-owned forward decrypt when that mount leaves', async () => {
        const encryption = installSession('leased-session');
        mocks.state.currentViewingSessionId = 'leased-session';
        mocks.apiRequest.mockResolvedValue(response({ messages: [], hasMore: false }));
        const opening = syncForTest.openSession('leased-session');
        await expect(opening).resolves.toBe('ready');
        syncForTest.sessionLastSeq.set('leased-session', 4);
        mocks.apiRequest.mockClear();
        const decrypted = deferred<any[]>();
        encryption.decryptMessages.mockImplementation(async () => decrypted.promise);
        mocks.state.mutableToolCalls.add('leased-session:call-1');
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(5), apiMessage(6), apiMessage(7)], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('leased-session', 7));
        await vi.waitFor(() => expect(encryption.decryptMessages).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('leased-session', 8));
        const messageSync = syncForTest.messagesSync.get('leased-session');
        syncForTest.abandonSessionRoute('leased-session', opening);
        mocks.state.currentViewingSessionId = null;
        decrypted.resolve([{
            id: 'message-5',
            localId: null,
            createdAt: 50,
            content: rawToolResult('uuid-stale-route'),
        }]);
        await messageSync.awaitQueue();

        expect(mocks.state.sessionMessages['leased-session']?.messagesMap['message-5']).toBeUndefined();
        expect(syncForTest.getSessionLastMessageSeq('leased-session')).toBe(4);
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
    });

    it('keeps a newer same-id open owned when an older route cleanup runs', async () => {
        const oldSnapshot = deferred<ApiSessionSnapshot | null>();
        mocks.fetchSnapshot
            .mockReturnValueOnce(oldSnapshot.promise)
            .mockResolvedValueOnce(snapshot('same-session', 20));
        mocks.apiRequest.mockResolvedValue(response({ messages: [], hasMore: false }));
        mocks.hydrateRoute.mockImplementation(async (raw: ApiSessionSnapshot) => {
            const encryption = {
                createDetached() { return this; },
                decryptMessage: vi.fn(async (message: ApiMessage) => ({
                    id: message.id,
                    localId: message.localId,
                    createdAt: message.createdAt,
                    content: rawText(`realtime-${message.seq}`),
                })),
                decryptMessages: vi.fn(async (messages: ApiMessage[]) => messages.map((message) => ({
                    id: message.id,
                    localId: message.localId,
                    createdAt: message.createdAt,
                    content: rawText(`fetched-${message.seq}`),
                }))),
            };
            return {
                session: hydrated(raw),
                commitEncryption: () => {
                    mocks.sessionEncryptions.set(raw.id, encryption);
                    return true;
                },
            };
        });

        const oldOpening = syncForTest.openSession('same-session');
        const newOpening = syncForTest.openSession('same-session');
        await expect(newOpening).resolves.toBe('ready');
        syncForTest.sessionLastSeq.set('same-session', 4);
        mocks.state.currentViewingSessionId = 'same-session';
        const forwardPage = deferred<Response>();
        mocks.apiRequest.mockClear();
        mocks.apiRequest.mockReturnValue(forwardPage.promise);
        await syncForTest.handleUpdate(newMessageUpdate('same-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const messageSync = syncForTest.messagesSync.get('same-session');
        syncForTest.abandonSessionRoute('same-session', oldOpening);
        forwardPage.resolve(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));
        await messageSync.awaitQueue();
        oldSnapshot.resolve(snapshot('same-session', 2));

        await expect(oldOpening).rejects.toThrow('abandoned');
        expect(mocks.state.sessions['same-session']).toMatchObject({ seq: 20 });
        expect(mocks.state.sessionMessages['same-session']).toMatchObject({ isLoaded: true });
        expect(mocks.state.sessionMessages['same-session'].messagesMap['message-7']).toBeDefined();
        expect(syncForTest.getSessionLastMessageSeq('same-session')).toBe(7);
    });

    it('releases an older-page loading lock when a forward load supersedes it in the same cache', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.sessionMessages['visible-session'] = {
            messages: [],
            messagesMap: {},
            isLoaded: true,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
        syncForTest.sessionLastSeq.set('visible-session', 109);
        syncForTest.sessionOldestSeq.set('visible-session', 103);
        const firstOlderPage = deferred<Response>();
        let olderRequests = 0;
        mocks.apiRequest.mockImplementation((url: string) => {
            if (url.includes('before_seq=')) {
                olderRequests += 1;
                return olderRequests === 1
                    ? firstOlderPage.promise
                    : Promise.resolve(response({ messages: [apiMessage(90)], hasMore: false }));
            }
            return Promise.resolve(response({
                messages: [apiMessage(110), apiMessage(111), apiMessage(112)],
                hasMore: false,
            }));
        });

        const olderLoading = syncForTest.loadOlderMessages('visible-session');
        await vi.waitFor(() => expect(olderRequests).toBe(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 112));
        firstOlderPage.resolve(response({ messages: [], hasMore: true }));
        await olderLoading;
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        expect(mocks.state.sessionMessages['visible-session'].isLoadingOlder).toBe(false);
        await syncForTest.loadOlderMessages('visible-session');
        expect(olderRequests).toBe(2);
        expect(mocks.state.sessionMessages['visible-session'].messagesMap['message-90']).toBeDefined();
    });

    it('does not let an evicted older-page cleanup clear a remounted cache loading lock', async () => {
        installSession('same-session');
        mocks.state.currentViewingSessionId = 'same-session';
        const installMessageCache = () => {
            mocks.state.sessionMessages['same-session'] = {
                messages: [],
                messagesMap: {},
                isLoaded: true,
                hasMoreOlder: true,
                isLoadingOlder: false,
            };
            syncForTest.sessionLastSeq.set('same-session', 109);
            syncForTest.sessionOldestSeq.set('same-session', 103);
        };
        installMessageCache();
        const oldPage = deferred<Response>();
        const newPage = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(oldPage.promise)
            .mockReturnValueOnce(newPage.promise);

        const oldLoading = syncForTest.loadOlderMessages('same-session');
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        syncForTest.releaseSessionMessageCache('same-session');
        installMessageCache();
        syncForTest.onSessionVisible('same-session', { loadMessages: false });
        const newLoading = syncForTest.loadOlderMessages('same-session');
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));

        oldPage.resolve(response({ messages: [], hasMore: true }));
        await oldLoading;
        expect(mocks.state.sessionMessages['same-session'].isLoadingOlder).toBe(true);

        newPage.resolve(response({ messages: [apiMessage(90)], hasMore: false }));
        await newLoading;
        expect(mocks.state.sessionMessages['same-session'].isLoadingOlder).toBe(false);
    });

    it('keeps explicit scroll-to-top pagination as the only older-page entry point', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.sessionMessages['visible-session'] = {
            messages: [],
            messagesMap: {},
            isLoaded: true,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
        syncForTest.sessionLastSeq.set('visible-session', 109);
        syncForTest.sessionOldestSeq.set('visible-session', 103);
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(90)], hasMore: true }));

        await syncForTest.loadOlderMessages('visible-session');

        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.apiRequest).toHaveBeenCalledWith(
            '/v3/sessions/visible-session/messages?before_seq=103&limit=100',
        );
        expect(mocks.state.sessionMessages['visible-session'].messagesMap['message-90']).toBeDefined();
        expect(syncForTest.sessionOldestSeq.get('visible-session')).toBe(90);
    });
});
