import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, deleteGeneration } = vi.hoisted(() => ({
    dbMock: {
        publicSessionShare: {
            findMany: vi.fn(),
            updateMany: vi.fn(async () => ({ count: 1 })),
            deleteMany: vi.fn(),
        },
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
    cleanupExpiredCapabilityShares,
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
        expect(dbMock.publicSessionShareDraft.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ expiresAt: { lte: new Date(-60 * 60 * 1000) } }),
        }));
        expect(deleteGeneration.mock.calls).toEqual([
            ['share-1', 'stale'],
            ['share-2', 'revoked-active'],
        ]);
        expect(dbMock.publicSessionShareDraft.deleteMany).toHaveBeenCalledTimes(2);
    });

    it('deletes expired capability shares only after every generation is removed from storage', async () => {
        dbMock.publicSessionShare.findMany.mockResolvedValue([{
            id: 'share-1',
            activeGeneration: 'published',
            revokedAt: new Date('2026-09-01T00:00:00.000Z'),
            drafts: [{ id: 'published' }, { id: 'stale' }],
        }]);
        deleteGeneration.mockResolvedValue(undefined);
        dbMock.publicSessionShare.deleteMany.mockResolvedValue({ count: 1 });

        expect(await cleanupExpiredCapabilityShares(new Date('2026-09-01T02:00:00.000Z'))).toBe(1);
        expect(deleteGeneration.mock.calls).toEqual([
            ['share-1', 'published'],
            ['share-1', 'stale'],
        ]);
        expect(dbMock.publicSessionShare.deleteMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ id: 'share-1' }),
        });
    });

    it('first revokes a newly expired capability share and retains it as an in-flight upload marker', async () => {
        dbMock.publicSessionShare.findMany.mockResolvedValue([{
            id: 'share-1',
            activeGeneration: 'published',
            revokedAt: null,
            drafts: [{ id: 'published' }],
        }]);

        expect(await cleanupExpiredCapabilityShares(new Date('2026-09-01T02:00:00.000Z'))).toBe(0);
        expect(dbMock.publicSessionShare.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: 'share-1', revokedAt: null }),
        }));
        expect(deleteGeneration).not.toHaveBeenCalled();
        expect(dbMock.publicSessionShare.deleteMany).not.toHaveBeenCalled();
    });

    it('retains an expired capability share when storage cleanup fails so the next pass retries it', async () => {
        dbMock.publicSessionShare.findMany.mockResolvedValue([{
            id: 'share-1',
            activeGeneration: 'published',
            revokedAt: new Date('2026-09-01T00:00:00.000Z'),
            drafts: [{ id: 'published' }],
        }]);
        deleteGeneration.mockRejectedValueOnce(new Error('S3 unavailable'));

        expect(await cleanupExpiredCapabilityShares(new Date('2026-09-01T02:00:00.000Z'))).toBe(0);
        expect(dbMock.publicSessionShare.deleteMany).not.toHaveBeenCalled();
    });
});
