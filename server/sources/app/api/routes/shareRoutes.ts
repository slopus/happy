import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { checkSessionAccess, canManageSharing, isSessionOwner, areFriends } from "@/app/share/accessControl";
import { ShareAccessLevel } from "@prisma/client";
import { logSessionShareAccess, getIpAddress, getUserAgent } from "@/app/share/accessLogger";
import { PROFILE_SELECT } from "@/app/share/types";
import { eventRouter, buildSessionSharedUpdate, buildSessionShareUpdatedUpdate, buildSessionShareRevokedUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

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
                sharedWithUser: share.sharedWithUser,
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
                encryptedDataKey: z.string() // base64 encoded
            })
        }
    }, async (request, reply) => {
        const ownerId = request.userId;
        const { sessionId } = request.params;
        const { userId, accessLevel, encryptedDataKey } = request.body;

        // Only owner or admin can create shares
        if (!await canManageSharing(ownerId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        // Cannot share with yourself
        if (userId === ownerId) {
            return reply.code(400).send({ error: 'Cannot share with yourself' });
        }

        // Verify target user exists
        const targetUser = await db.account.findUnique({
            where: { id: userId }
        });

        if (!targetUser) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Check if users are friends
        if (!await areFriends(ownerId, userId)) {
            return reply.code(403).send({ error: 'Can only share with friends' });
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
                encryptedDataKey: new Uint8Array(Buffer.from(encryptedDataKey, 'base64'))
            },
            update: {
                accessLevel: accessLevel as ShareAccessLevel,
                encryptedDataKey: new Uint8Array(Buffer.from(encryptedDataKey, 'base64'))
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
                sharedWithUser: share.sharedWithUser,
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
                sharedWithUser: share.sharedWithUser,
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

    /**
     * Get sessions shared with current user
     */
    app.get('/v1/shares/sessions', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        const shares = await db.sessionShare.findMany({
            where: { sharedWithUserId: userId },
            include: {
                session: {
                    select: {
                        id: true,
                        seq: true,
                        createdAt: true,
                        updatedAt: true,
                        metadata: true,
                        metadataVersion: true,
                        active: true,
                        lastActiveAt: true
                    }
                },
                sharedByUser: {
                    select: PROFILE_SELECT
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return reply.send({
            shares: shares.map(share => ({
                id: share.id,
                session: {
                    id: share.session.id,
                    seq: share.session.seq,
                    createdAt: share.session.createdAt.getTime(),
                    updatedAt: share.session.updatedAt.getTime(),
                    active: share.session.active,
                    activeAt: share.session.lastActiveAt.getTime(),
                    metadata: share.session.metadata,
                    metadataVersion: share.session.metadataVersion
                },
                sharedBy: share.sharedByUser,
                accessLevel: share.accessLevel,
                encryptedDataKey: Buffer.from(share.encryptedDataKey).toString('base64'),
                createdAt: share.createdAt.getTime(),
                updatedAt: share.updatedAt.getTime()
            }))
        });
    });

    /**
     * Get shared session details with encrypted key
     */
    app.get('/v1/shares/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const access = await checkSessionAccess(userId, sessionId);
        if (!access) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        // If owner, return without share info
        if (access.isOwner) {
            const session = await db.session.findUnique({
                where: { id: sessionId },
                select: {
                    id: true,
                    seq: true,
                    createdAt: true,
                    updatedAt: true,
                    metadata: true,
                    metadataVersion: true,
                    agentState: true,
                    agentStateVersion: true,
                    dataEncryptionKey: true,
                    active: true,
                    lastActiveAt: true
                }
            });

            if (!session) {
                return reply.code(404).send({ error: 'Session not found' });
            }

            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null
                },
                accessLevel: access.level,
                isOwner: true
            });
        }

        // Get share with encrypted key
        const share = await db.sessionShare.findUnique({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId,
                    sharedWithUserId: userId
                }
            },
            include: {
                session: {
                    select: {
                        id: true,
                        seq: true,
                        createdAt: true,
                        updatedAt: true,
                        metadata: true,
                        metadataVersion: true,
                        agentState: true,
                        agentStateVersion: true,
                        active: true,
                        lastActiveAt: true
                    }
                }
            }
        });

        if (!share) {
            return reply.code(404).send({ error: 'Share not found' });
        }

        // Log access
        const ipAddress = getIpAddress(request.headers);
        const userAgent = getUserAgent(request.headers);
        await logSessionShareAccess(share.id, userId, ipAddress, userAgent);

        return reply.send({
            session: {
                id: share.session.id,
                seq: share.session.seq,
                createdAt: share.session.createdAt.getTime(),
                updatedAt: share.session.updatedAt.getTime(),
                active: share.session.active,
                activeAt: share.session.lastActiveAt.getTime(),
                metadata: share.session.metadata,
                metadataVersion: share.session.metadataVersion,
                agentState: share.session.agentState,
                agentStateVersion: share.session.agentStateVersion
            },
            accessLevel: share.accessLevel,
            encryptedDataKey: Buffer.from(share.encryptedDataKey).toString('base64'),
            isOwner: false
        });
    });
}
