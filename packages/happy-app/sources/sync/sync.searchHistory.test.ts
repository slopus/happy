import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: { sessions: {} as Record<string, unknown> },
    fetch: vi.fn(),
}));

// Same boundary as sync.preload.test.ts: real Sync, no Expo runtime or sockets.
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: vi.fn() } }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: vi.fn() }, getCurrentAppState: () => 'active', getHappyClientId: () => 'test' }));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('@/sync/encryption/artifactEncryption', () => ({ ArtifactEncryption: class {} }));
vi.mock('@/sync/encryption/encryptionCache', () => ({ EncryptionCache: class {} }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('@/sync/ops', () => ({ sessionSetAgentModes: vi.fn() }));
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
vi.mock('@/sync/typesRaw', () => ({ normalizeRawMessage: (_i: string, _l: string, _t: number, c: unknown) => c }));
vi.mock('@/config', () => ({ config: {} }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/track', () => ({ tracking: null }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/encryption/blob', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: () => ({ invalidate: vi.fn() }) } }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({ voiceHooks: { onSessionFocus: vi.fn(), onMessages: vi.fn(), onReady: vi.fn() } }));

import { sync } from './sync';

let engine: any;
let ingest: ReturnType<typeof vi.fn>;

function row(id: string) {
    return { id, tag: id, seq: 0, metadata: '', metadataVersion: 0, agentState: null, agentStateVersion: 0,
        dataEncryptionKey: null, active: false, activeAt: 1, createdAt: 1, updatedAt: 1, lastMessage: null };
}
function page(ids: string[], nextCursor: string | null) {
    return { ok: true, json: async () => ({ sessions: ids.map(row), nextCursor }) };
}
function urlOf(call: number): string {
    return String(mocks.fetch.mock.calls[call][0]);
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.state = { sessions: {} };
    engine = new (sync.constructor as new () => typeof sync)();
    engine.credentials = { token: 'tok' };
    ingest = vi.fn(async (rows: any[]) => rows);
    engine.ingestSessions = ingest;
});

describe('loadAllSessionsForSearch', () => {
    it('follows the v2 cursor to the end and ingests every page', async () => {
        mocks.fetch
            .mockResolvedValueOnce(page(['a', 'b'], 'cursor_v1_b'))
            .mockResolvedValueOnce(page(['c'], null));
        await engine.loadAllSessionsForSearch();
        expect(urlOf(0)).toBe('https://example.invalid/v2/sessions?limit=200');
        expect(urlOf(1)).toBe('https://example.invalid/v2/sessions?limit=200&cursor=cursor_v1_b');
        expect(ingest.mock.calls.map((c) => c[0].map((r: any) => r.id))).toEqual([['a', 'b'], ['c']]);
    });

    it('skips rows the boot fetch already put in the store', async () => {
        mocks.state.sessions = { a: {} };
        mocks.fetch.mockResolvedValueOnce(page(['a', 'b'], null));
        await engine.loadAllSessionsForSearch();
        expect(ingest).toHaveBeenCalledOnce();
        expect(ingest.mock.calls[0][0].map((r: any) => r.id)).toEqual(['b']);
    });

    it('does not ingest an empty diff and runs only once per app run', async () => {
        mocks.state.sessions = { a: {} };
        mocks.fetch.mockResolvedValue(page(['a'], null));
        await engine.loadAllSessionsForSearch();
        await engine.loadAllSessionsForSearch();
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(ingest).not.toHaveBeenCalled();
    });

    it('lets a later open retry after a failed page', async () => {
        mocks.fetch
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce(page(['a'], null));
        await expect(engine.loadAllSessionsForSearch()).rejects.toThrow('500');
        await engine.loadAllSessionsForSearch();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(ingest).toHaveBeenCalledOnce();
    });
});
