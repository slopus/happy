import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Metadata } from './storageTypes';
import { sessionRename } from './ops';

const mocks = vi.hoisted(() => ({
    emitWithAck: vi.fn(),
    getSessionEncryption: vi.fn(),
    encryptMetadata: vi.fn(),
    decryptMetadata: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: {
        emitWithAck: mocks.emitWithAck,
    },
}));

vi.mock('./sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: mocks.getSessionEncryption,
        },
    },
}));

const sessionId = 'session-1';

const metadata: Metadata = {
    path: '/workspace/project',
    host: 'workstation',
    name: 'Production Dashboard',
};

describe('sessionRename', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionEncryption.mockReturnValue({
            encryptMetadata: mocks.encryptMetadata,
            decryptMetadata: mocks.decryptMetadata,
        });
        mocks.encryptMetadata.mockImplementation(async (value: Metadata) => `encrypted:${value.name ?? ''}:${value.path}`);
    });

    it('encrypts and sends renamed session metadata with the expected version', async () => {
        mocks.emitWithAck.mockResolvedValue({
            result: 'success',
            version: 3,
            metadata: 'server-encrypted-metadata',
        });

        await expect(sessionRename(sessionId, metadata, 'Production Dashboard', 2)).resolves.toEqual({
            version: 3,
            metadata: 'server-encrypted-metadata',
        });

        expect(mocks.getSessionEncryption).toHaveBeenCalledWith(sessionId);
        expect(mocks.encryptMetadata).toHaveBeenCalledWith(metadata);
        expect(mocks.emitWithAck).toHaveBeenCalledWith('update-metadata', {
            sid: sessionId,
            metadata: 'encrypted:Production Dashboard:/workspace/project',
            expectedVersion: 2,
        });
    });

    it('throws when a success response is missing updated metadata details', async () => {
        mocks.emitWithAck.mockResolvedValue({
            result: 'success',
        });

        await expect(sessionRename(sessionId, metadata, 'Production Dashboard', 2)).rejects.toThrow(
            'Session rename succeeded without returning updated metadata'
        );
    });

    it('retries version conflicts by preserving the requested name on latest metadata', async () => {
        const latestMetadata: Metadata = {
            path: '/workspace/new-project',
            host: 'new-workstation',
            summary: {
                text: 'Latest automatic summary',
                updatedAt: 42,
            },
            name: 'Server-side old name',
        };

        mocks.decryptMetadata.mockResolvedValue(latestMetadata);
        mocks.emitWithAck
            .mockResolvedValueOnce({
                result: 'version-mismatch',
                version: 5,
                metadata: 'latest-encrypted-metadata',
            })
            .mockResolvedValueOnce({
                result: 'success',
                version: 6,
                metadata: 'final-encrypted-metadata',
            });

        await expect(sessionRename(sessionId, metadata, 'Production Dashboard', 4)).resolves.toEqual({
            version: 6,
            metadata: 'final-encrypted-metadata',
        });

        expect(mocks.decryptMetadata).toHaveBeenCalledWith(5, 'latest-encrypted-metadata');
        expect(mocks.encryptMetadata).toHaveBeenNthCalledWith(2, {
            ...latestMetadata,
            name: 'Production Dashboard',
        });
        expect(mocks.emitWithAck).toHaveBeenNthCalledWith(2, 'update-metadata', {
            sid: sessionId,
            metadata: 'encrypted:Production Dashboard:/workspace/new-project',
            expectedVersion: 5,
        });
    });
});
