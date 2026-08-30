import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, deleteGeneration } = vi.hoisted(() => ({
    dbMock: {
        publicSessionShareDraft: {
            findMany: vi.fn(),
            deleteMany: vi.fn(),
        },
    },
    deleteGeneration: vi.fn(),
}));

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('./publicSessionShareStorage', () => ({ deletePublicShareGeneration: deleteGeneration }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import {
    cleanupExpiredPublicSessionShareDrafts,
    cleanupPublicSessionShareGeneration,
} from './publicSessionShareCleanup';

describe('public session share cleanup', () => {
    beforeEach(() => vi.clearAllMocks());

    it('retains the database row when object deletion fails so cleanup can retry', async () => {
        deleteGeneration.mockRejectedValueOnce(new Error('S3 unavailable'));
        await expect(cleanupPublicSessionShareGeneration('share-1', 'draft-1')).rejects.toThrow('S3 unavailable');
        expect(dbMock.publicSessionShareDraft.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes only expired non-active generations after storage succeeds', async () => {
        dbMock.publicSessionShareDraft.findMany.mockResolvedValue([
            { id: 'stale', shareId: 'share-1', share: { activeGeneration: 'active', revokedAt: null } },
            { id: 'active', shareId: 'share-1', share: { activeGeneration: 'active', revokedAt: null } },
            { id: 'revoked-active', shareId: 'share-2', share: { activeGeneration: 'revoked-active', revokedAt: new Date() } },
        ]);
        deleteGeneration.mockResolvedValue(undefined);
        dbMock.publicSessionShareDraft.deleteMany.mockResolvedValue({ count: 1 });

        expect(await cleanupExpiredPublicSessionShareDrafts(new Date(0))).toBe(2);
        expect(deleteGeneration.mock.calls).toEqual([
            ['share-1', 'stale'],
            ['share-2', 'revoked-active'],
        ]);
        expect(dbMock.publicSessionShareDraft.deleteMany).toHaveBeenCalledTimes(2);
    });
});
