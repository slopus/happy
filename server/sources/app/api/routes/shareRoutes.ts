import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { checkSessionAccess, canManageSharing, isSessionOwner } from "@/app/share/accessControl";
import { ShareAccessLevel } from "@prisma/client";

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
                    select: {
                        id: true,
                        profile: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        return reply.send({
            shares: shares.map(share => ({
                id: share.id,
                sharedWithUser: {
                    id: share.sharedWithUser.id,
                    profile: share.sharedWithUser.profile
                },
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
                encryptedDataKey: Buffer.from(encryptedDataKey, 'base64')
            },
            update: {
                accessLevel: accessLevel as ShareAccessLevel,
                encryptedDataKey: Buffer.from(encryptedDataKey, 'base64')
            },
            include: {
                sharedWithUser: {
                    select: {
                        id: true,
                        profile: true
                    }
                }
            }
        });

        return reply.send({
            share: {
                id: share.id,
                sharedWithUser: {
                    id: share.sharedWithUser.id,
                    profile: share.sharedWithUser.profile
                },
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
                    select: {
                        id: true,
                        profile: true
                    }
                }
            }
        });

        return reply.send({
            share: {
                id: share.id,
                sharedWithUser: {
                    id: share.sharedWithUser.id,
                    profile: share.sharedWithUser.profile
                },
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

        await db.sessionShare.delete({
            where: { id: shareId, sessionId }
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
                    select: {
                        id: true,
                        profile: true
                    }
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
                sharedBy: {
                    id: share.sharedByUser.id,
                    profile: share.sharedByUser.profile
                },
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
