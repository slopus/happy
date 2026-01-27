import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { canManageSharing, areFriends } from "@/app/share/accessControl";
import { ShareAccessLevel } from "@prisma/client";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { eventRouter, buildSessionSharedUpdate, buildSessionShareUpdatedUpdate, buildSessionShareRevokedUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

function parseEncryptedDataKeyV0(encryptedDataKeyB64: string): Uint8Array {
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(Buffer.from(encryptedDataKeyB64, 'base64'));
    } catch {
        throw new Error('Invalid base64');
    }
    // version (1) + ephemeral pk (32) + nonce (24) + mac (16) = 73 minimum
    if (bytes.length < 1 + 32 + 24 + 16) {
        throw new Error('encryptedDataKey too short');
    }
    if (bytes[0] !== 0) {
        throw new Error('Unsupported encryptedDataKey version');
    }
    return bytes;
}

/**
 * Session sharing API routes
 */
export function shareRoutes(app: Fastify) {

    /**
     * Get all shares for a session (owner/admin only)
     */
    app.get('/v1/sessions/:sessionId/shares', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Only owner or admin can view shares
        if (!await canManageSharing(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const shares = await db.sessionShare.findMany({
            where: { sessionId },
            include: {
                sharedWithUser: {
                    select: PROFILE_SELECT
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return reply.send({
            shares: shares.map(share => ({
                id: share.id,
                sharedWithUser: toShareUserProfile(share.sharedWithUser),
                accessLevel: share.accessLevel,
                createdAt: share.createdAt.getTime(),
                updatedAt: share.updatedAt.getTime()
            }))
        });
    });

    /**
     * Share session with a user
     */
    app.post('/v1/sessions/:sessionId/shares', {
        preHandler: app.authenticate,
        config: {
            rateLimit: {
                max: 20,
                timeWindow: '1 minute'
            }
        },
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                userId: z.string(),
                accessLevel: z.enum(['view', 'edit', 'admin']),
                encryptedDataKey: z.string(),
            })
        }
    }, async (request, reply) => {
        const ownerId = request.userId;
        const { sessionId } = request.params;
        const { userId, accessLevel, encryptedDataKey } = request.body;

        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Only owner or admin can create shares
        if (!await canManageSharing(ownerId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        // Cannot share with yourself
        if (userId === ownerId) {
            return reply.code(400).send({ error: 'Cannot share with yourself' });
        }

        // Verify target user exists and get their public key
        const targetUser = await db.account.findUnique({
            where: { id: userId },
            select: { id: true }
        });

        if (!targetUser) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Check if users are friends
        if (!await areFriends(ownerId, userId)) {
            return reply.code(403).send({ error: 'Can only share with friends' });
        }

        let encryptedDataKeyBytes: Uint8Array;
        try {
            encryptedDataKeyBytes = parseEncryptedDataKeyV0(encryptedDataKey);
        } catch (error) {
            return reply.code(400).send({ error: 'Invalid encryptedDataKey' });
        }

        // Create or update share
        const share = await db.sessionShare.upsert({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId,
                    sharedWithUserId: userId
                }
            },
            create: {
                sessionId,
                sharedByUserId: ownerId,
                sharedWithUserId: userId,
                accessLevel: accessLevel as ShareAccessLevel,
                encryptedDataKey: encryptedDataKeyBytes
            },
            update: {
                accessLevel: accessLevel as ShareAccessLevel,
                encryptedDataKey: encryptedDataKeyBytes
            },
            include: {
                sharedWithUser: {
                    select: PROFILE_SELECT
                },
                sharedByUser: {
                    select: PROFILE_SELECT
                }
            }
        });

        // Emit real-time update to shared user
        const updateSeq = await allocateUserSeq(userId);
        const updatePayload = buildSessionSharedUpdate(share, updateSeq, randomKeyNaked(12));
        eventRouter.emitUpdate({
            userId: userId,
            payload: updatePayload,
            recipientFilter: { type: 'all-user-authenticated-connections' }
        });

        return reply.send({
            share: {
                id: share.id,
                sharedWithUser: toShareUserProfile(share.sharedWithUser),
                accessLevel: share.accessLevel,
                createdAt: share.createdAt.getTime(),
                updatedAt: share.updatedAt.getTime()
            }
        });
    });

    /**
     * Update share access level
     */
    app.patch('/v1/sessions/:sessionId/shares/:shareId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                shareId: z.string()
            }),
            body: z.object({
                accessLevel: z.enum(['view', 'edit', 'admin'])
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, shareId } = request.params;
        const { accessLevel } = request.body;

        // Only owner or admin can update shares
        if (!await canManageSharing(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const share = await db.sessionShare.update({
            where: { id: shareId, sessionId },
            data: { accessLevel: accessLevel as ShareAccessLevel },
            include: {
                sharedWithUser: {
                    select: PROFILE_SELECT
                }
            }
        });

        // Emit real-time update to shared user
        const updateSeq = await allocateUserSeq(share.sharedWithUserId);
        const updatePayload = buildSessionShareUpdatedUpdate(
            share.id,
            share.sessionId,
            share.accessLevel,
            share.updatedAt,
            updateSeq,
            randomKeyNaked(12)
        );
        eventRouter.emitUpdate({
            userId: share.sharedWithUserId,
            payload: updatePayload,
            recipientFilter: { type: 'all-user-authenticated-connections' }
        });

        return reply.send({
            share: {
                id: share.id,
                sharedWithUser: toShareUserProfile(share.sharedWithUser),
                accessLevel: share.accessLevel,
                createdAt: share.createdAt.getTime(),
                updatedAt: share.updatedAt.getTime()
            }
        });
    });

    /**
     * Delete share (revoke access)
     */
    app.delete('/v1/sessions/:sessionId/shares/:shareId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                shareId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, shareId } = request.params;

        // Only owner or admin can delete shares
        if (!await canManageSharing(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        // Use transaction to ensure consistent state
        const result = await db.$transaction(async (tx) => {
            // Get share before deleting
            const share = await tx.sessionShare.findUnique({
                where: { id: shareId, sessionId }
            });

            if (!share) {
                return { error: 'Share not found' };
            }

            // Delete share
            await tx.sessionShare.delete({
                where: { id: shareId, sessionId }
            });

            return { share };
        });

        if ('error' in result) {
            return reply.code(404).send({ error: result.error });
        }

        // Emit real-time update to shared user (outside transaction)
        const updateSeq = await allocateUserSeq(result.share.sharedWithUserId);
        const updatePayload = buildSessionShareRevokedUpdate(
            result.share.id,
            result.share.sessionId,
            updateSeq,
            randomKeyNaked(12)
        );
        eventRouter.emitUpdate({
            userId: result.share.sharedWithUserId,
            payload: updatePayload,
            recipientFilter: { type: 'all-user-authenticated-connections' }
        });

        return reply.send({ success: true });
    });
}
