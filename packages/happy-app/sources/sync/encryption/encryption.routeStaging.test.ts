import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionSnapshot } from '../apiTypes';
import { hydrateSessionSnapshotForRoute } from '../sessionSnapshotHydration';
import { Encryption } from './encryption';
import { EncryptionCache } from './encryptionCache';
import { SessionEncryption } from './sessionEncryption';

vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    (globalThis as unknown as { expo?: { EventEmitter: unknown } }).expo = {
        EventEmitter: EventTarget,
    };
});

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn(() => 'test-uuid') }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createEncryptionForRouteTest() {
    const encryption = Object.create(Encryption.prototype) as any;
    encryption.sessionEncryptions = new Map();
    encryption.sessionBlobKeys = new Map();
    encryption.cache = new EncryptionCache();
    encryption.masterBlobKey = new Uint8Array([1, 2, 3]);
    encryption.openEncryption = vi.fn(async () => ({
        decrypt: vi.fn(async () => []),
        encrypt: vi.fn(async () => []),
    }));
    return encryption;
}

const routeSnapshot: ApiSessionSnapshot = {
    id: 'session-1',
    seq: 1,
    metadata: 'AA==',
    metadataVersion: 2,
    agentState: 'AA==',
    agentStateVersion: 3,
    dataEncryptionKey: null,
    active: true,
    activeAt: 1,
    createdAt: 1,
    updatedAt: 1,
    lastMessage: null,
};

function createEncryptor(results: unknown[]) {
    return {
        decrypt: vi.fn(async () => [results.shift()]),
        encrypt: vi.fn(async () => []),
    };
}

describe('route session encryption staging', () => {
    it('keeps encryption private while preparation is pending and until commit', async () => {
        const encryption = createEncryptionForRouteTest();
        const encryptor = deferred<{ decrypt: ReturnType<typeof vi.fn>; encrypt: ReturnType<typeof vi.fn> }>();
        encryption.openEncryption.mockReturnValue(encryptor.promise);

        const preparing = encryption.prepareSessionEncryption('session-1', null);
        expect(encryption.getSessionEncryption('session-1')).toBeNull();
        encryptor.resolve({
            decrypt: vi.fn(async () => []),
            encrypt: vi.fn(async () => []),
        });
        const prepared = await preparing;

        expect(encryption.getSessionEncryption('session-1')).toBeNull();
        expect(prepared.commit()).toBe(true);
        expect(encryption.getSessionEncryption('session-1')).not.toBeNull();
    });

    it('does not let an older staged commit overwrite a newer same-session commit', async () => {
        const encryption = createEncryptionForRouteTest();
        const older = await encryption.prepareSessionEncryption('session-1', null);
        const newer = await encryption.prepareSessionEncryption('session-1', null);

        expect(newer.commit()).toBe(true);
        const newerCommitted = encryption.getSessionEncryption('session-1');
        expect(older.commit()).toBe(false);

        expect(encryption.getSessionEncryption('session-1')).toBe(newerCommitted);
    });

    it('refuses an existing-encryption transaction after that encryption is replaced', async () => {
        const encryption = createEncryptionForRouteTest();
        const existing = new SessionEncryption(
            'session-1',
            createEncryptor([]),
            encryption.cache,
        );
        const replacement = { id: 'replacement' };
        encryption.sessionEncryptions.set('session-1', existing);
        const prepared = await encryption.prepareSessionEncryption('session-1', null);

        encryption.sessionEncryptions.set('session-1', replacement);

        expect(prepared.commit()).toBe(false);
        expect(encryption.getSessionEncryption('session-1')).toBe(replacement);
    });

    it('keeps existing-encryption route preparation out of the shared cache and selects the existing winner on commit', async () => {
        const encryption = createEncryptionForRouteTest();
        const sharedCache = encryption.cache as EncryptionCache;
        const originalStats = sharedCache.getStats();
        const existingBlobKey = new Uint8Array([9, 8, 7]);
        const existingEncryptor = createEncryptor([
            { path: '/winner', host: 'winner-host' },
            { controlledByUser: false },
            { path: '/winner', host: 'winner-host' },
            { controlledByUser: false },
        ]);
        const existing = new SessionEncryption('session-1', existingEncryptor, sharedCache);
        const snapshotKeyEncryptor = createEncryptor([
            { path: '/wrong-key', host: 'wrong-key-host' },
            { controlledByUser: true },
        ]);
        encryption.sessionEncryptions.set('session-1', existing);
        encryption.sessionBlobKeys.set('session-1', existingBlobKey);
        encryption.openEncryption.mockResolvedValue(snapshotKeyEncryptor);

        const transaction = await hydrateSessionSnapshotForRoute(routeSnapshot, encryption, {
            assertCurrent: () => undefined,
        });

        expect(transaction).not.toBeNull();
        expect(transaction!.session.metadata).toEqual({ path: '/winner', host: 'winner-host' });
        expect(transaction!.session.agentState).toEqual({ controlledByUser: false });
        expect(sharedCache.getStats()).toEqual(originalStats);
        expect(sharedCache.getCachedMetadata('session-1', 2)).toBeNull();
        expect(sharedCache.getCachedAgentState('session-1', 3)).toBeNull();
        expect(transaction!.commitEncryption()).toBe(true);
        expect(sharedCache.getStats()).toEqual(originalStats);
        expect(encryption.getSessionEncryption('session-1')).toBe(existing);
        expect(encryption.sessionBlobKeys.get('session-1')).toBe(existingBlobKey);

        await expect(existing.decryptMetadata(2, routeSnapshot.metadata)).resolves.toEqual({
            path: '/winner',
            host: 'winner-host',
        });
        await expect(existing.decryptAgentState(3, routeSnapshot.agentState)).resolves.toEqual({
            controlledByUser: false,
        });
        expect(existingEncryptor.decrypt).toHaveBeenCalledTimes(4);
        expect(encryption.openEncryption).not.toHaveBeenCalled();
    });

    it('does not leak staged metadata or agent state when existing encryption is replaced during route decryption', async () => {
        const encryption = createEncryptionForRouteTest();
        const sharedCache = encryption.cache as EncryptionCache;
        const originalStats = sharedCache.getStats();
        const stagedMetadata = deferred<unknown>();
        const stagedAgentState = deferred<unknown>();
        const stagedEncryptor = {
            decrypt: vi.fn()
                .mockReturnValueOnce(stagedMetadata.promise.then((value) => [value]))
                .mockReturnValueOnce(stagedAgentState.promise.then((value) => [value])),
            encrypt: vi.fn(async () => []),
        };
        const existing = new SessionEncryption('session-1', stagedEncryptor, sharedCache);
        const replacementEncryptor = createEncryptor([
            { path: '/replacement', host: 'replacement-host' },
            { controlledByUser: false },
        ]);
        const replacement = new SessionEncryption('session-1', replacementEncryptor, sharedCache);
        encryption.sessionEncryptions.set('session-1', existing);
        encryption.openEncryption.mockResolvedValue(stagedEncryptor);

        const hydrating = hydrateSessionSnapshotForRoute(routeSnapshot, encryption, {
            assertCurrent: () => undefined,
        });
        await vi.waitFor(() => expect(stagedEncryptor.decrypt).toHaveBeenCalledTimes(2));
        encryption.sessionEncryptions.set('session-1', replacement);
        stagedMetadata.resolve({ path: '/stale', host: 'stale-host' });
        stagedAgentState.resolve({ controlledByUser: true });
        const transaction = await hydrating;

        expect(sharedCache.getStats()).toEqual(originalStats);
        expect(sharedCache.getCachedMetadata('session-1', 2)).toBeNull();
        expect(sharedCache.getCachedAgentState('session-1', 3)).toBeNull();
        expect(transaction).not.toBeNull();
        expect(transaction!.commitEncryption()).toBe(false);
        expect(sharedCache.getStats()).toEqual(originalStats);
        expect(encryption.getSessionEncryption('session-1')).toBe(replacement);

        await expect(replacement.decryptMetadata(2, routeSnapshot.metadata)).resolves.toEqual({
            path: '/replacement',
            host: 'replacement-host',
        });
        await expect(replacement.decryptAgentState(3, routeSnapshot.agentState)).resolves.toEqual({
            controlledByUser: false,
        });
        expect(replacementEncryptor.decrypt).toHaveBeenCalledTimes(2);
    });
});
