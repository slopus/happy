import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Native update identity has its own tests; these suites do not host Expo modules.
vi.mock('@/sync/nativeUpdate', () => ({ refreshNativeUpdateStatus: vi.fn(async () => ({ status: 'unsupported', available: false })) }));
import { Platform } from 'react-native';
import type { ApiSessionSnapshot } from './apiTypes';
import type { HydratedSession } from './sessionSnapshotHydration';

vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    (globalThis as unknown as { expo?: { EventEmitter: unknown } }).expo = {
        EventEmitter: EventTarget,
    };
});

const { apiSocket, fetchSessionSnapshot, hydrateSessionSnapshots, reconcileSessionHistory, storage, storageState } = vi.hoisted(() => {
    const storageState = {
        settings: { sidebarOrganization: { lists: [], tags: [], sessions: {} } },
        sessions: {} as Record<string, HydratedSession>,
        sessionMessages: {} as Record<string, unknown>,
        getActiveSessions: () => [],
        applySessions: (sessions: HydratedSession[], options?: { replace?: boolean }) => {
            if (options?.replace) {
                storageState.sessions = {};
            }
            for (const session of sessions) {
                storageState.sessions[session.id] = session;
            }
        },
        deleteSession: (sessionId: string) => {
            delete storageState.sessions[sessionId];
        },
    };
    return {
        apiSocket: {
            onMessage: vi.fn(),
            onStatusChange: vi.fn(),
            onReconnected: vi.fn(),
            sendAppState: vi.fn(),
        },
        fetchSessionSnapshot: vi.fn(),
        hydrateSessionSnapshots: vi.fn(),
        reconcileSessionHistory: vi.fn(),
        storage: {
            getState: () => storageState,
            setState: (update: any) => {
                const next = typeof update === 'function' ? update(storageState) : update;
                Object.assign(storageState, next);
            },
        },
        storageState,
    };
});

vi.mock('./sessionSnapshotHydration', () => ({ hydrateSessionSnapshots,
    hydrateSessionSnapshotForRoute: async (snapshot: ApiSessionSnapshot, encryption: unknown) => {
        const sessions = await hydrateSessionSnapshots([snapshot], encryption);
        return sessions[0] ? { session: sessions[0], commitEncryption: () => true } : null;
    },
}));
vi.mock('./apiSessions', async importOriginal => ({
    ...await importOriginal<typeof import('./apiSessions')>(),
    fetchSessionSnapshot,
}));
vi.mock('./sessionHistoryReconciliation', () => ({ reconcileSessionHistory }));
vi.mock('./storage', () => ({ storage }));
vi.mock('./apiSocket', () => ({
    apiSocket,
    getCurrentAppState: vi.fn(() => 'active'),
    getHappyClientId: vi.fn(() => 'test-client'),
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

const update = {
    id: 'update-1',
    seq: 9,
    createdAt: 100,
    body: {
        t: 'new-session' as const,
        id: 'session-1',
        seq: 9,
        metadata: 'metadata',
        metadataVersion: 4,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
        active: false,
        activeAt: 100,
        createdAt: 90,
        updatedAt: 100,
        lastMessage: null,
    },
};

const hydratedSession: HydratedSession = {
    ...update.body,
    metadata: { name: 'New session' } as any,
    agentState: null,
    thinking: false,
    thinkingAt: 0,
};

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('new-session updates', () => {
    const syncForTest = sync as any;
    let applySessions: ReturnType<typeof vi.spyOn>;
    let sessionsSyncInvalidate: ReturnType<typeof vi.fn>;

    const installReconnectHarness = (localHistory: object | null) => {
        const original = {
            localHistory: syncForTest.localHistory,
            changesSupported: syncForTest.changesSupported,
            sessionBootstrapSync: syncForTest.sessionBootstrapSync,
            machinesSync: syncForTest.machinesSync,
            artifactsSync: syncForTest.artifactsSync,
            feedSync: syncForTest.feedSync,
            pluginCatalogSync: syncForTest.pluginCatalogSync,
            sendSync: syncForTest.sendSync,
        };
        const activeInvalidate = vi.fn();
        syncForTest.localHistory = localHistory;
        syncForTest.changesSupported = null;
        syncForTest.sessionBootstrapSync = { invalidate: activeInvalidate };
        syncForTest.machinesSync = { invalidate: vi.fn() };
        syncForTest.artifactsSync = { invalidate: vi.fn() };
        syncForTest.feedSync = { invalidate: vi.fn() };
        syncForTest.pluginCatalogSync = { invalidate: vi.fn() };
        syncForTest.sendSync = new Map();
        syncForTest.subscribeToUpdates();
        const reconnected = apiSocket.onReconnected.mock.calls.at(-1)?.[0];
        expect(reconnected).toBeTypeOf('function');
        return {
            activeInvalidate,
            reconnected: reconnected!,
            restore: () => Object.assign(syncForTest, original),
        };
    };

    beforeEach(() => {
        syncForTest.sessionEventCursors.clear();
        syncForTest.sessionHydrations.clear();
        syncForTest.inFlightSessionRefreshes.clear();
        syncForTest.sessionDeletionMutationGenerations.clear();
        apiSocket.onMessage.mockReset();
        apiSocket.onReconnected.mockReset();
        apiSocket.sendAppState.mockReset();
        fetchSessionSnapshot.mockReset();
        apiSocket.onMessage.mockReset();
        apiSocket.onReconnected.mockReset();
        apiSocket.sendAppState.mockReset();
        hydrateSessionSnapshots.mockReset();
        hydrateSessionSnapshots.mockResolvedValue([hydratedSession]);
        reconcileSessionHistory.mockReset();
        reconcileSessionHistory.mockResolvedValue('supported');
        storageState.sessions = {};
        storageState.sessionMessages = {};
        applySessions = vi.spyOn(syncForTest, 'applySessions');
        sessionsSyncInvalidate = vi.fn();
        syncForTest.encryption = {
            getSessionEncryption: vi.fn(() => null),
            removeSessionEncryption: vi.fn(),
        };
        syncForTest.credentials = { token: 'test-token', secret: 'test-secret' };
        syncForTest.sessionsSync = { invalidate: sessionsSyncInvalidate };
    });

    afterEach(() => {
        applySessions.mockRestore();
        storageState.sessions = {};
        vi.unstubAllGlobals();
    });

    // Regression: invalidating the full sessions sync here makes a newly
    // spawned session wait for account-wide hydration before it is visible.
    it('hydrates and merges the new-session snapshot without invalidating the account sync', async () => {
        await syncForTest.handleUpdate(update);

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'session-1' }),
        ], { replace: false });
        expect(hydrateSessionSnapshots).toHaveBeenCalledWith([
            expect.objectContaining({ id: 'session-1' }),
        ], syncForTest.encryption);
        expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
    });

    it('reconciles durable history on reconnect without invalidating the legacy full session list', async () => {
        const harness = installReconnectHarness({});

        try {
            harness.reconnected();

            await vi.waitFor(() => expect(reconcileSessionHistory).toHaveBeenCalledTimes(1));
            await syncForTest.sessionReconnectSync.awaitQueue();
            expect(harness.activeInvalidate).toHaveBeenCalledTimes(1);
            expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
        } finally {
            harness.restore();
        }
    });

    it('refreshes bounded active summaries on reconnect when durable history is unavailable', async () => {
        const harness = installReconnectHarness(null);

        try {
            harness.reconnected();

            await syncForTest.sessionReconnectSync.awaitQueue();
            expect(harness.activeInvalidate).toHaveBeenCalledTimes(1);
            expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
        } finally {
            harness.restore();
        }
    });

    it('reconciles the native change cursor on reconnect without durable local history', async () => {
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        const harness = installReconnectHarness(null);
        const reconcile = vi.spyOn(syncForTest, 'reconcileHistory').mockResolvedValue(undefined);

        try {
            harness.reconnected();

            await syncForTest.sessionReconnectSync.awaitQueue();
            expect(reconcile).toHaveBeenCalledTimes(1);
            expect(harness.activeInvalidate).toHaveBeenCalledTimes(1);
            expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
        } finally {
            reconcile.mockRestore();
            harness.restore();
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('retries a failed reconnect reconciliation without falling back to the legacy full list', async () => {
        const harness = installReconnectHarness({});
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const random = vi.spyOn(Math, 'random').mockReturnValue(0);
        reconcileSessionHistory
            .mockRejectedValueOnce(new Error('temporary changes failure'))
            .mockResolvedValueOnce('supported');
        try {
            harness.reconnected();

            await vi.waitFor(() => expect(reconcileSessionHistory).toHaveBeenCalledTimes(2));
            await syncForTest.sessionReconnectSync.awaitQueue();
            expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
        } finally {
            harness.restore();
            random.mockRestore();
            warning.mockRestore();
        }
    });

    it('runs a trailing reconciliation when reconnect fires during an in-flight pass', async () => {
        const harness = installReconnectHarness({});
        const firstPass = deferred<'supported'>();
        reconcileSessionHistory
            .mockReturnValueOnce(firstPass.promise)
            .mockResolvedValueOnce('supported');
        try {
            harness.reconnected();
            await vi.waitFor(() => expect(reconcileSessionHistory).toHaveBeenCalledTimes(1));

            harness.reconnected();
            firstPass.resolve('supported');

            await vi.waitFor(() => expect(reconcileSessionHistory).toHaveBeenCalledTimes(2));
            await syncForTest.sessionReconnectSync.awaitQueue();
            expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
        } finally {
            firstPass.resolve('supported');
            harness.restore();
        }
    });

    it('runs a fresh cursor pass when reconnect overlaps reconciliation started elsewhere', async () => {
        const harness = installReconnectHarness({});
        const earlierPass = deferred<'supported'>();
        reconcileSessionHistory
            .mockReturnValueOnce(earlierPass.promise)
            .mockResolvedValueOnce('supported');

        try {
            const earlierReconciliation = syncForTest.reconcileHistory();
            await vi.waitFor(() => expect(reconcileSessionHistory).toHaveBeenCalledTimes(1));

            harness.reconnected();
            earlierPass.resolve('supported');
            await earlierReconciliation;

            await vi.waitFor(() => expect(reconcileSessionHistory).toHaveBeenCalledTimes(2));
            await syncForTest.sessionReconnectSync.awaitQueue();
            expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
        } finally {
            earlierPass.resolve('supported');
            harness.restore();
        }
    });

    it('falls back to bounded active summaries when the server does not support change cursors', async () => {
        const harness = installReconnectHarness({});
        reconcileSessionHistory.mockResolvedValue('unsupported');

        try {
            harness.reconnected();

            await vi.waitFor(() => expect(harness.activeInvalidate).toHaveBeenCalledTimes(1));
            await syncForTest.sessionReconnectSync.awaitQueue();
            expect(sessionsSyncInvalidate).not.toHaveBeenCalled();
        } finally {
            harness.restore();
        }
    });

    // Regression: a delayed socket snapshot must not replace newer metadata
    // already applied from a later event or a single-session fetch.
    it('does not overwrite newer stored metadata with an older new-session snapshot', async () => {
        storageState.sessions['session-1'] = {
            ...hydratedSession,
            seq: 9,
            metadata: { name: 'Current session' } as any,
            metadataVersion: 5,
            presence: 100,
        };

        await syncForTest.handleUpdate(update);

        expect(hydrateSessionSnapshots).toHaveBeenCalledTimes(1);
        expect(storageState.sessions['session-1']).toMatchObject({
            seq: 9,
            metadata: { name: 'Current session' },
            metadataVersion: 5,
        });
    });

    // Regression: `/new` used to fetch and decrypt the full `/v1/sessions`
    // response even when the requested session was already ready locally.
    it('does not fetch when the requested session and its encryption are already present', async () => {
        storageState.sessions['session-1'] = hydratedSession;
        syncForTest.encryption.getSessionEncryption.mockReturnValue({});

        await expect(syncForTest.ensureSessionHydrated('session-1')).resolves.toBe(true);

        expect(fetchSessionSnapshot).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('returns false when the single-session endpoint reports no session', async () => {
        fetchSessionSnapshot.mockResolvedValue(null);

        await expect(syncForTest.ensureSessionHydrated('missing-session')).resolves.toBe(false);

        expect(fetchSessionSnapshot).toHaveBeenCalledWith(syncForTest.credentials, 'missing-session');
        expect(applySessions).not.toHaveBeenCalled();
    });

    // Regression: a full refresh can start before a socket update, then return
    // afterwards with a stale list. Its replace write must not revert newer
    // fields or remove a session created during the request. Omission from a
    // paginated list is not deletion evidence, including previously cached rows.
    it('reconciles a stale full refresh against realtime sessions applied while it was in flight', async () => {
        const staleSnapshot = { ...update.body, seq: 2, metadataVersion: 2 };
        const realtimeSnapshot = { ...update.body, seq: 5, metadataVersion: 5 };
        const createdSnapshot = { ...update.body, id: 'session-2', seq: 1, metadataVersion: 1 };
        let resolveResponse: (response: Response) => void;
        const response = new Promise<Response>((resolve) => {
            resolveResponse = resolve;
        });
        vi.stubGlobal('fetch', vi.fn(() => response));
        hydrateSessionSnapshots.mockImplementation(async (snapshots: ApiSessionSnapshot[]) => snapshots.map((snapshot) => ({
            ...snapshot,
            metadata: { name: `Session ${snapshot.metadataVersion}` } as any,
            agentState: null,
            thinking: false,
            thinkingAt: 0,
        })));
        storageState.sessions = {
            'session-1': { ...hydratedSession, seq: 1, metadataVersion: 1 },
            'old-cache': { ...hydratedSession, id: 'old-cache', seq: 1 },
        };

        const refresh = syncForTest.fetchSessions();
        await Promise.resolve();
        await syncForTest.handleUpdate({ ...update, body: realtimeSnapshot });
        await syncForTest.handleUpdate({ ...update, id: 'update-2', body: createdSnapshot });
        resolveResponse!({ ok: true, json: async () => ({ sessions: [staleSnapshot] }) } as Response);
        await refresh;

        expect(storageState.sessions['session-1']).toMatchObject({
            seq: 5,
            metadata: { name: 'Session 5' },
            metadataVersion: 5,
        });
        expect(storageState.sessions['session-2']).toMatchObject({ id: 'session-2' });
        expect(storageState.sessions['old-cache']).toMatchObject({ id: 'old-cache', seq: 1 });
    });

    // Regression: a realtime delete is newer than a refresh that was already
    // in flight, so the refresh's stale row must not resurrect that session.
    it('does not resurrect a session deleted while a full refresh was in flight', async () => {
        const staleSnapshot = { ...update.body, seq: 2, metadataVersion: 2 };
        let resolveResponse: (response: Response) => void;
        const response = new Promise<Response>((resolve) => {
            resolveResponse = resolve;
        });
        vi.stubGlobal('fetch', vi.fn(() => response));
        hydrateSessionSnapshots.mockImplementation(async (snapshots: ApiSessionSnapshot[]) => snapshots.map((snapshot) => ({
            ...snapshot,
            metadata: { name: `Session ${snapshot.metadataVersion}` } as any,
            agentState: null,
            thinking: false,
            thinkingAt: 0,
        })));
        storageState.sessions = {
            'session-1': { ...hydratedSession, seq: 1, metadataVersion: 1 },
        };

        const refresh = syncForTest.fetchSessions();
        await Promise.resolve();
        await syncForTest.handleUpdate({
            ...update,
            body: { t: 'delete-session', sid: 'session-1' },
        });
        resolveResponse!({ ok: true, json: async () => ({ sessions: [staleSnapshot] }) } as Response);
        await refresh;

        expect(storageState.sessions['session-1']).toBeUndefined();
        expect(syncForTest.sessionDeletionMutationGenerations.size).toBe(0);
    });
});
