import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionSnapshot } from './apiTypes';
import type { Encryption } from './encryption/encryption';
import { hydrateSessionSnapshotForRoute, hydrateSessionSnapshots } from './sessionSnapshotHydration';

const snapshot: ApiSessionSnapshot = {
    id: 'session-1',
    seq: 7,
    metadata: 'metadata',
    metadataVersion: 2,
    agentState: 'agent-state',
    agentStateVersion: 3,
    dataEncryptionKey: 'encrypted-data-key',
    active: true,
    activeAt: 100,
    createdAt: 90,
    updatedAt: 100,
    lastMessage: null,
};

function createEncryption() {
    const decryptedKey = new Uint8Array([1, 2, 3]);
    let initialized = false;
    const sessionEncryption = {
        decryptMetadata: vi.fn(async (version: number, encrypted: string) => {
            if (!initialized) throw new Error('metadata decrypted before session initialization');
            return { title: `${encrypted}-${version}` };
        }),
        decryptAgentState: vi.fn(async (version: number, encrypted: string | null) => {
            if (!initialized) throw new Error('agent state decrypted before session initialization');
            return encrypted ? { state: `${encrypted}-${version}` } : null;
        }),
    };
    const encryption = {
        decryptEncryptionKey: vi.fn(async () => decryptedKey),
        initializeSessions: vi.fn(async () => {
            initialized = true;
        }),
        getSessionEncryption: vi.fn(() => sessionEncryption),
    } as unknown as Encryption;

    return { encryption, decryptedKey, sessionEncryption };
}

describe('hydrateSessionSnapshots', () => {
    it('hydrates exactly the supplied snapshots after initializing their keys', async () => {
        const { encryption, decryptedKey, sessionEncryption } = createEncryption();

        const result = await hydrateSessionSnapshots([snapshot], encryption);

        expect(encryption.decryptEncryptionKey).toHaveBeenCalledTimes(1);
        expect(encryption.initializeSessions).toHaveBeenCalledWith(
            new Map([['session-1', decryptedKey]]),
        );
        expect(sessionEncryption.decryptMetadata).toHaveBeenCalledWith(2, 'metadata');
        expect(sessionEncryption.decryptAgentState).toHaveBeenCalledWith(3, 'agent-state');
        expect(result).toEqual([
            expect.objectContaining({
                id: 'session-1',
                metadata: { title: 'metadata-2' },
                agentState: { state: 'agent-state-3' },
                thinking: false,
                thinkingAt: 0,
            }),
        ]);
    });

    it('skips only the snapshot whose data key cannot be decrypted', async () => {
        const { encryption } = createEncryption();
        const logger = { warn: vi.fn() };
        encryption.decryptEncryptionKey = vi.fn(async (encryptedKey: string) => (
            encryptedKey === 'bad-data-key' ? null : new Uint8Array([4, 5, 6])
        ));
        const validSnapshot = { ...snapshot, id: 'session-2', dataEncryptionKey: 'valid-data-key' };
        const invalidSnapshot = { ...snapshot, id: 'session-3', dataEncryptionKey: 'bad-data-key' };

        const result = await hydrateSessionSnapshots([validSnapshot, invalidSnapshot], encryption, logger);

        expect(result.map((session) => session.id)).toEqual(['session-2']);
        expect(logger.warn).toHaveBeenCalledWith('Skipping session snapshot because its data key could not be decrypted');
    });

    it('does not commit a prepared route encryption after the operation becomes stale during decryption', async () => {
        let resolveMetadata!: (value: { title: string }) => void;
        const metadata = new Promise<{ title: string }>((resolve) => {
            resolveMetadata = resolve;
        });
        let current = true;
        const commit = vi.fn();
        const routeEncryption = {
            decryptMetadata: vi.fn(() => metadata),
            decryptAgentState: vi.fn(async () => ({ state: 'new-agent-state' })),
        };
        const encryption = {
            decryptEncryptionKey: vi.fn(async () => new Uint8Array([7, 8, 9])),
            prepareSessionEncryption: vi.fn(async () => ({
                sessionEncryption: routeEncryption,
                commit,
            })),
        } as unknown as Encryption;
        const guard = {
            assertCurrent: () => {
                if (!current) throw new Error('Session route abandoned');
            },
        };

        const hydrating = hydrateSessionSnapshotForRoute(snapshot, encryption, guard);
        await vi.waitFor(() => expect(routeEncryption.decryptMetadata).toHaveBeenCalledTimes(1));
        current = false;
        resolveMetadata({ title: 'stale-title' });

        await expect(hydrating).rejects.toThrow('abandoned');
        expect(commit).not.toHaveBeenCalled();
    });

    it('returns route hydration as an uncommitted transaction', async () => {
        const commit = vi.fn(() => true);
        const routeEncryption = {
            decryptMetadata: vi.fn(async () => ({ title: 'prepared-title' })),
            decryptAgentState: vi.fn(async () => ({ state: 'prepared-agent-state' })),
        };
        const encryption = {
            decryptEncryptionKey: vi.fn(async () => new Uint8Array([7, 8, 9])),
            prepareSessionEncryption: vi.fn(async () => ({
                sessionEncryption: routeEncryption,
                commit,
            })),
        } as unknown as Encryption;

        const transaction = await hydrateSessionSnapshotForRoute(snapshot, encryption, {
            assertCurrent: () => undefined,
        });

        expect(commit).not.toHaveBeenCalled();
        expect(transaction).toEqual({
            session: expect.objectContaining({
                id: 'session-1',
                metadata: { title: 'prepared-title' },
                agentState: { state: 'prepared-agent-state' },
            }),
            commitEncryption: commit,
        });
    });
});
