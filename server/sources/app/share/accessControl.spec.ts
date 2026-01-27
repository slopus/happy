import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkSessionAccess, checkPublicShareAccess, isSessionOwner, canManageSharing, areFriends } from './accessControl';
import { db } from '@/storage/db';

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findUnique: vi.fn()
        },
        sessionShare: {
            findUnique: vi.fn()
        },
        publicSessionShare: {
            findUnique: vi.fn()
        },
        userRelationship: {
            findFirst: vi.fn()
        }
    }
}));

describe('accessControl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('checkSessionAccess', () => {
        it('should return owner access when user owns the session', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-1'
            } as any);

            const result = await checkSessionAccess('user-1', 'session-1');

            expect(result).toEqual({
                userId: 'user-1',
                sessionId: 'session-1',
                level: 'owner',
                isOwner: true
            });
        });

        it('should return null when session does not exist', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue(null);

            const result = await checkSessionAccess('user-1', 'session-1');

            expect(result).toBeNull();
        });

        it('should return shared access level when session is shared with user', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-owner'
            } as any);

            vi.mocked(db.sessionShare.findUnique).mockResolvedValue({
                accessLevel: 'view'
            } as any);

            const result = await checkSessionAccess('user-1', 'session-1');

            expect(result).toEqual({
                userId: 'user-1',
                sessionId: 'session-1',
                level: 'view',
                isOwner: false
            });
        });

        it('should return null when user has no access to session', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-owner'
            } as any);

            vi.mocked(db.sessionShare.findUnique).mockResolvedValue(null);

            const result = await checkSessionAccess('user-1', 'session-1');

            expect(result).toBeNull();
        });
    });

    describe('checkPublicShareAccess', () => {
        it('should return access info for valid token', async () => {
            const mockShare = {
                id: 'public-1',
                sessionId: 'session-1',
                expiresAt: null,
                maxUses: null,
                useCount: 5,
                blockedUsers: []
            };

            vi.mocked(db.publicSessionShare.findUnique).mockResolvedValue(mockShare as any);

            const result = await checkPublicShareAccess('valid-token', null);

            expect(result).toEqual({
                sessionId: 'session-1',
                publicShareId: 'public-1'
            });
        });

        it('should return null for invalid token', async () => {
            vi.mocked(db.publicSessionShare.findUnique).mockResolvedValue(null);

            const result = await checkPublicShareAccess('invalid-token', null);

            expect(result).toBeNull();
        });

        it('should return null for expired shares', async () => {
            const pastDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
            const mockShare = {
                id: 'public-1',
                sessionId: 'session-1',
                expiresAt: pastDate,
                maxUses: null,
                useCount: 0,
                blockedUsers: []
            };

            vi.mocked(db.publicSessionShare.findUnique).mockResolvedValue(mockShare as any);

            const result = await checkPublicShareAccess('valid-token', null);

            expect(result).toBeNull();
        });

        it('should return null when max uses reached', async () => {
            const mockShare = {
                id: 'public-1',
                sessionId: 'session-1',
                expiresAt: null,
                maxUses: 10,
                useCount: 10,
                blockedUsers: []
            };

            vi.mocked(db.publicSessionShare.findUnique).mockResolvedValue(mockShare as any);

            const result = await checkPublicShareAccess('valid-token', null);

            expect(result).toBeNull();
        });
    });

    describe('isSessionOwner', () => {
        it('should return true when user owns the session', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-1'
            } as any);

            const result = await isSessionOwner('user-1', 'session-1');

            expect(result).toBe(true);
        });

        it('should return false when user does not own the session', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-owner'
            } as any);

            const result = await isSessionOwner('user-1', 'session-1');

            expect(result).toBe(false);
        });

        it('should return false when session does not exist', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue(null);

            const result = await isSessionOwner('user-1', 'session-1');

            expect(result).toBe(false);
        });
    });

    describe('canManageSharing', () => {
        it('should return true for session owner', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-1'
            } as any);

            const result = await canManageSharing('user-1', 'session-1');

            expect(result).toBe(true);
        });

        it('should return true for admin access level', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-owner'
            } as any);

            vi.mocked(db.sessionShare.findUnique).mockResolvedValue({
                accessLevel: 'admin'
            } as any);

            const result = await canManageSharing('user-1', 'session-1');

            expect(result).toBe(true);
        });

        it('should return false for view access level', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-owner'
            } as any);

            vi.mocked(db.sessionShare.findUnique).mockResolvedValue({
                accessLevel: 'view'
            } as any);

            const result = await canManageSharing('user-1', 'session-1');

            expect(result).toBe(false);
        });

        it('should return false for edit access level', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-owner'
            } as any);

            vi.mocked(db.sessionShare.findUnique).mockResolvedValue({
                accessLevel: 'edit'
            } as any);

            const result = await canManageSharing('user-1', 'session-1');

            expect(result).toBe(false);
        });

        it('should return false when user has no access', async () => {
            vi.mocked(db.session.findUnique).mockResolvedValue({
                id: 'session-1',
                accountId: 'user-owner'
            } as any);

            vi.mocked(db.sessionShare.findUnique).mockResolvedValue(null);

            const result = await canManageSharing('user-1', 'session-1');

            expect(result).toBe(false);
        });
    });

    describe('areFriends', () => {
        it('should return true when users are friends (from->to)', async () => {
            vi.mocked(db.userRelationship.findFirst).mockResolvedValue({
                fromUserId: 'user-1',
                toUserId: 'user-2',
                status: 'friend'
            } as any);

            const result = await areFriends('user-1', 'user-2');

            expect(result).toBe(true);
        });

        it('should return true when users are friends (to->from)', async () => {
            vi.mocked(db.userRelationship.findFirst).mockResolvedValue({
                fromUserId: 'user-2',
                toUserId: 'user-1',
                status: 'friend'
            } as any);

            const result = await areFriends('user-1', 'user-2');

            expect(result).toBe(true);
        });

        it('should return false when users are not friends', async () => {
            vi.mocked(db.userRelationship.findFirst).mockResolvedValue(null);

            const result = await areFriends('user-1', 'user-2');

            expect(result).toBe(false);
        });

        it('should return false when relationship is pending', async () => {
            vi.mocked(db.userRelationship.findFirst).mockResolvedValue(null);

            const result = await areFriends('user-1', 'user-2');

            expect(result).toBe(false);
        });
    });
});
