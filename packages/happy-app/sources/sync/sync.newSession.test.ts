import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionSnapshot } from './apiTypes';
import type { HydratedSession } from './sessionSnapshotHydration';

vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    (globalThis as unknown as { expo?: { EventEmitter: unknown } }).expo = {
        EventEmitter: EventTarget,
    };
});

const { fetchSessionSnapshot, hydrateSessionSnapshots, storage, storageState } = vi.hoisted(() => {
    const storageState = {
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
        fetchSessionSnapshot: vi.fn(),
        hydrateSessionSnapshots: vi.fn(),
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
vi.mock('./apiSessions', () => ({ fetchSessionSnapshot }));
vi.mock('./storage', () => ({ storage }));
vi.mock('./apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onReconnected: vi.fn(),
        sendAppState: vi.fn(),
    },
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

describe('new-session updates', () => {
    const syncForTest = sync as any;
    let applySessions: ReturnType<typeof vi.spyOn>;
    let sessionsSyncInvalidate: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        syncForTest.sessionEventCursors.clear();
        syncForTest.sessionHydrations.clear();
        syncForTest.inFlightSessionRefreshes.clear();
        syncForTest.sessionDeletionMutationGenerations.clear();
        fetchSessionSnapshot.mockReset();
        hydrateSessionSnapshots.mockReset();
        hydrateSessionSnapshots.mockResolvedValue([hydratedSession]);
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
    // fields, remove a session created during the request, or retain cache rows
    // that were already stale when the request began.
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
        expect(storageState.sessions['old-cache']).toBeUndefined();
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
