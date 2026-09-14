import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';

const mocks = vi.hoisted(() => ({
    state: {} as any,
    request: vi.fn(),
    alert: vi.fn(),
}));

// Real Sync, key wrapping, key derivation, session decryption and outbox.
// Only platform services and the authenticated HTTP/store boundaries are replaced.
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({
    randomUUID: () => randomUUID(),
    getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)),
    CryptoDigestAlgorithm: { SHA512: 'SHA-512' },
    digest: (algorithm: string, bytes: Uint8Array) => webcrypto.subtle.digest(algorithm, bytes),
}));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: vi.fn() } }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: sodium }));
vi.mock('@/encryption/aes', () => import('@/encryption/aes.web'));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: mocks.request }, getCurrentAppState: () => 'active', getHappyClientId: () => 'test' }));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
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
vi.mock('@/config', () => ({ config: {} }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/track', () => ({ tracking: null, trackMessageSent: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/readFileBytes', () => ({}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: {} }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({ voiceHooks: { onSessionOnline: vi.fn(), onSessionOffline: vi.fn() } }));

import { sync } from './sync';
import { Encryption } from './encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { settingsDefaults } from './settings';

let engine: any;
let writer: Encryption;
let fetchMock: ReturnType<typeof vi.fn>;
const accountSecret = new Uint8Array(32).fill(7);

async function sessionRecord(id: string, legacy = false) {
    const key = legacy ? null : new Uint8Array(32).fill(9);
    await writer.initializeSessions(new Map([[id, key]]));
    return {
        id, seq: 0, createdAt: 2, updatedAt: 2, active: true, activeAt: 2,
        metadata: await writer.getSessionEncryption(id)!.encryptMetadata({ path: '/test', host: 'test', flavor: 'claude' }),
        metadataVersion: 1, agentState: null, agentStateVersion: 0,
        dataEncryptionKey: key ? encodeBase64(await writer.encryptEncryptionKey(key)) : null,
        lastMessage: null,
    };
}

beforeEach(async () => {
    await sodium.ready;
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.state = {
        sessions: {}, settings: settingsDefaults,
        getActiveSessions: () => [],
        applySessions: (sessions: any[]) => { for (const session of sessions) mocks.state.sessions[session.id] = session; },
        markSessionMessageSent: vi.fn(),
    };
    engine = new (sync.constructor as any)();
    engine.credentials = { token: 'test-only', secret: 'test-only' };
    engine.encryption = await Encryption.create(accountSecret);
    writer = await Encryption.create(accountSecret);
    // UI reduction is unrelated to placement; retain the real encrypted outbox.
    vi.spyOn(engine, 'enqueueMessages').mockImplementation(() => {});
    vi.spyOn(engine, 'getMessagesSync').mockReturnValue({ invalidate: vi.fn() });
    vi.spyOn(engine.projectsSync, 'invalidate').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mocks.request.mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
});

afterEach(() => {
    engine.sessionsSync.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('first message session hydration', () => {
    it.each([false, true])('sends a new top-of-list session despite an unrelated corrupt record (legacy=%s)', async (legacy) => {
        const target = await sessionRecord('new-session', legacy);
        const unrelated = { ...await sessionRecord('old-session'), metadata: 'not valid base64!' };
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [target, unrelated] }) });

        // Model the initial account sync. Before the fix it rejects after
        // initializing keys and leaves even the healthy new row unpublished.
        await engine.fetchSessions().catch(() => {});
        vi.useFakeTimers();
        const sending = engine.sendMessage('new-session', 'first prompt', { awaitDelivery: true });
        await vi.advanceTimersByTimeAsync(13_000);
        await sending;
        expect(mocks.request).toHaveBeenCalledOnce();
        const [path, request] = mocks.request.mock.calls[0];
        expect(path).toBe('/v3/sessions/new-session/messages');
        const batch = JSON.parse(request.body).messages;
        expect(batch).toHaveLength(1);
        expect(await writer.getSessionEncryption('new-session')!.decryptRaw(batch[0].content))
            .toMatchObject({ role: 'user', content: { type: 'text', text: 'first prompt' } });
        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it('hydrates a cold new session with its own key before its first send', async () => {
        const target = await sessionRecord('new-session');
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [target] }) });
        await expect(engine.sendMessage('new-session', 'cold start', { awaitDelivery: true })).resolves.toBe(true);
        expect(mocks.state.sessions['new-session'].metadata.path).toBe('/test');
        expect(engine.encryption.getSessionBlobKey('new-session')).not.toBeNull();
        expect(mocks.request).toHaveBeenCalledOnce();
    });

    it.each(['missing', 'foreign-key', 'bad-metadata', 'bad-state', 'network'])('preserves a real failure without sending under another key: %s', async (failure) => {
        const target = await sessionRecord('new-session');
        if (failure === 'foreign-key') {
            const foreignAccount = await Encryption.create(new Uint8Array(32).fill(42));
            target.dataEncryptionKey = encodeBase64(await foreignAccount.encryptEncryptionKey(new Uint8Array(32).fill(9)));
        }
        if (failure === 'bad-metadata') target.metadata = 'invalid base64!';
        if (failure === 'bad-state') (target as any).agentState = 'invalid base64!';
        const unrelated = await sessionRecord('other-session');
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: failure === 'missing' ? [unrelated] : [target, unrelated] }) });
        await engine.fetchSessions();
        if (failure === 'network') {
            delete mocks.state.sessions['new-session'];
            fetchMock.mockRejectedValue(new Error('offline'));
        }
        vi.useFakeTimers();
        const sending = engine.sendMessage('new-session', 'do not lose me');
        await vi.advanceTimersByTimeAsync(13_000);
        await expect(sending).resolves.toBe(false);
        expect(mocks.request).not.toHaveBeenCalled();
        expect(engine.pendingOutbox.size).toBe(0);
        expect(mocks.alert).toHaveBeenCalledWith('common.error', expect.stringContaining('has not finished syncing'));
        expect(mocks.state.sessions['other-session']).toBeDefined();
    });

    it.each(['cancel', 'delete', 'account-change', 'target-change'])('does not accept a message if %s happens during encryption', async (change) => {
        const target = await sessionRecord('new-session');
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [target] }) });
        await engine.fetchSessions();
        let finish!: (encrypted: string) => void;
        const encrypt = vi.spyOn(engine.encryption.getSessionEncryption('new-session'), 'encryptRawRecord')
            .mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const controller = new AbortController();
        const accepted = vi.fn();
        let currentTarget = true;
        const sending = engine.sendMessage('new-session', 'original target', { signal: controller.signal, isCurrent: () => currentTarget, onAccepted: accepted });
        await vi.waitFor(() => expect(encrypt).toHaveBeenCalledOnce());
        if (change === 'cancel') controller.abort();
        if (change === 'target-change') currentTarget = false;
        if (change === 'delete') delete mocks.state.sessions['new-session'];
        if (change === 'account-change') engine.encryption = await Encryption.create(new Uint8Array(32).fill(42));
        finish('encrypted-test-record');
        await expect(sending).resolves.toBe(false);
        expect(mocks.request).not.toHaveBeenCalled();
        expect(engine.pendingOutbox.size).toBe(0);
        expect(accepted).not.toHaveBeenCalled();
    });

    it('does not queue file events or text after Stop during attachment upload', async () => {
        const target = await sessionRecord('new-session');
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [target] }) });
        await engine.fetchSessions();
        let finish!: (result: unknown) => void;
        const upload = vi.spyOn(engine, 'uploadAttachmentsForSession').mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const controller = new AbortController();
        const sending = engine.sendMessage('new-session', 'with image', {
            signal: controller.signal,
            attachments: [{ id: 'image', uri: 'file:///test.jpg', name: 'test.jpg', size: 1, width: 1, height: 1 }],
        });
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
        controller.abort();
        finish({ uploaded: [{ ref: 'test-image', name: 'test.jpg', size: 1, width: 1, height: 1 }], failed: 0 });
        await expect(sending).resolves.toBe(false);
        expect(engine.pendingOutbox.size).toBe(0);
        expect(engine.enqueueMessages).not.toHaveBeenCalled();
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('keeps the requested destination when the visible session changes, and commits before cancellation', async () => {
        const target = await sessionRecord('new-session');
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [target] }) });
        await engine.fetchSessions();
        const controller = new AbortController();
        mocks.state.currentViewingSessionId = 'different-session';
        const onAccepted = vi.fn(() => {
            expect(engine.pendingOutbox.get('new-session')).toHaveLength(1);
            controller.abort(); // Acceptance is already irreversible.
        });
        await expect(engine.sendMessage('new-session', 'only here', {
            signal: controller.signal, onAccepted, awaitDelivery: true,
        })).resolves.toBe(true);
        expect(onAccepted).toHaveBeenCalledOnce();
        expect(mocks.request.mock.calls[0][0]).toBe('/v3/sessions/new-session/messages');
    });
});