import { describe, it, expect } from 'vitest';
import {
    buildSessionSharedUpdate,
    buildSessionShareUpdatedUpdate,
    buildSessionShareRevokedUpdate,
    buildPublicShareCreatedUpdate,
    buildPublicShareUpdatedUpdate,
    buildPublicShareDeletedUpdate
} from './eventRouter';

describe('Sharing Event Builders', () => {
    describe('buildSessionSharedUpdate', () => {
        it('should build session-shared update event', () => {
            const share = {
                id: 'share-1',
                sessionId: 'session-1',
                sharedByUser: {
                    id: 'user-owner',
                    firstName: 'John',
                    lastName: 'Doe',
                    username: 'johndoe',
                    avatar: null
                },
                accessLevel: 'view' as const,
                encryptedDataKey: new Uint8Array([1, 2, 3, 4]),
                createdAt: new Date('2025-01-09T12:00:00Z')
            };

            const result = buildSessionSharedUpdate(share, 100, 'update-id-1');

            expect(result).toMatchObject({
                id: 'update-id-1',
                seq: 100,
                body: {
                    t: 'session-shared',
                    sessionId: 'session-1',
                    shareId: 'share-1',
                    sharedBy: share.sharedByUser,
                    accessLevel: 'view',
                    encryptedDataKey: expect.any(String),
                    createdAt: share.createdAt.getTime()
                }
            });
            expect(result.createdAt).toBeGreaterThan(0);
        });
    });

    describe('buildSessionShareUpdatedUpdate', () => {
        it('should build session-share-updated event', () => {
            const updatedAt = new Date('2025-01-09T13:00:00Z');
            const result = buildSessionShareUpdatedUpdate(
                'share-1',
                'session-1',
                'edit',
                updatedAt,
                101,
                'update-id-2'
            );

            expect(result).toMatchObject({
                id: 'update-id-2',
                seq: 101,
                body: {
                    t: 'session-share-updated',
                    sessionId: 'session-1',
                    shareId: 'share-1',
                    accessLevel: 'edit',
                    updatedAt: updatedAt.getTime()
                }
            });
        });
    });

    describe('buildSessionShareRevokedUpdate', () => {
        it('should build session-share-revoked event', () => {
            const result = buildSessionShareRevokedUpdate(
                'share-1',
                'session-1',
                102,
                'update-id-3'
            );

            expect(result).toMatchObject({
                id: 'update-id-3',
                seq: 102,
                body: {
                    t: 'session-share-revoked',
                    sessionId: 'session-1',
                    shareId: 'share-1'
                }
            });
        });
    });

    describe('buildPublicShareCreatedUpdate', () => {
        it('should build public-share-created event with all fields', () => {
            const publicShare = {
                id: 'public-1',
                sessionId: 'session-1',
                token: 'abc123',
                expiresAt: new Date('2025-02-09T12:00:00Z'),
                maxUses: 100,
                isConsentRequired: true,
                createdAt: new Date('2025-01-09T12:00:00Z')
            };

            const result = buildPublicShareCreatedUpdate(publicShare, 103, 'update-id-4');

            expect(result).toMatchObject({
                id: 'update-id-4',
                seq: 103,
                body: {
                    t: 'public-share-created',
                    sessionId: 'session-1',
                    publicShareId: 'public-1',
                    token: 'abc123',
                    expiresAt: publicShare.expiresAt.getTime(),
                    maxUses: 100,
                    isConsentRequired: true,
                    createdAt: publicShare.createdAt.getTime()
                }
            });
        });

        it('should handle null expiration and max uses', () => {
            const publicShare = {
                id: 'public-2',
                sessionId: 'session-2',
                token: 'xyz789',
                expiresAt: null,
                maxUses: null,
                isConsentRequired: false,
                createdAt: new Date('2025-01-09T12:00:00Z')
            };

            const result = buildPublicShareCreatedUpdate(publicShare, 104, 'update-id-5');

            expect(result.body).toMatchObject({
                expiresAt: null,
                maxUses: null,
                isConsentRequired: false
            });
        });
    });

    describe('buildPublicShareUpdatedUpdate', () => {
        it('should build public-share-updated event', () => {
            const publicShare = {
                id: 'public-1',
                sessionId: 'session-1',
                expiresAt: new Date('2025-02-10T12:00:00Z'),
                maxUses: 200,
                isConsentRequired: false,
                updatedAt: new Date('2025-01-09T14:00:00Z')
            };

            const result = buildPublicShareUpdatedUpdate(publicShare, 105, 'update-id-6');

            expect(result).toMatchObject({
                id: 'update-id-6',
                seq: 105,
                body: {
                    t: 'public-share-updated',
                    sessionId: 'session-1',
                    publicShareId: 'public-1',
                    expiresAt: publicShare.expiresAt.getTime(),
                    maxUses: 200,
                    isConsentRequired: false,
                    updatedAt: publicShare.updatedAt.getTime()
                }
            });
        });
    });

    describe('buildPublicShareDeletedUpdate', () => {
        it('should build public-share-deleted event', () => {
            const result = buildPublicShareDeletedUpdate('session-1', 106, 'update-id-7');

            expect(result).toMatchObject({
                id: 'update-id-7',
                seq: 106,
                body: {
                    t: 'public-share-deleted',
                    sessionId: 'session-1'
                }
            });
        });
    });
});
