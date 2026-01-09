import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { isSessionOwner } from "@/app/share/accessControl";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { logPublicShareAccess, getIpAddress, getUserAgent } from "@/app/share/accessLogger";
import { PROFILE_SELECT } from "@/app/share/types";
import { eventRouter, buildPublicShareCreatedUpdate, buildPublicShareUpdatedUpdate, buildPublicShareDeletedUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";

/**
 * Public session sharing API routes
 *
 * Public shares are always view-only for security
 */
export function publicShareRoutes(app: Fastify) {

    /**
     * Create or update public share for a session
     */
    app.post('/v1/sessions/:sessionId/public-share', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                encryptedDataKey: z.string(), // base64 encoded
                expiresAt: z.number().optional(), // timestamp
                maxUses: z.number().int().positive().optional(),
                isConsentRequired: z.boolean().optional() // require consent for detailed logging
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { encryptedDataKey, expiresAt, maxUses, isConsentRequired } = request.body;

        // Only owner can create public shares
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        // Check if public share already exists
        const existing = await db.publicSessionShare.findUnique({
            where: { sessionId }
        });

        let publicShare;
        const isUpdate = !!existing;

        if (existing) {
            // Update existing share
            publicShare = await db.publicSessionShare.update({
                where: { sessionId },
                data: {
                    encryptedDataKey: new Uint8Array(Buffer.from(encryptedDataKey, 'base64')),
                    expiresAt: expiresAt ? new Date(expiresAt) : null,
                    maxUses: maxUses ?? null,
                    isConsentRequired: isConsentRequired ?? false
                }
            });
        } else {
            // Create new share with random token
            const token = randomKeyNaked();
            publicShare = await db.publicSessionShare.create({
                data: {
                    sessionId,
                    createdByUserId: userId,
                    token,
                    encryptedDataKey: new Uint8Array(Buffer.from(encryptedDataKey, 'base64')),
                    expiresAt: expiresAt ? new Date(expiresAt) : null,
                    maxUses: maxUses ?? null,
                    isConsentRequired: isConsentRequired ?? false
                }
            });
        }

        // Emit real-time update to session owner
        const updateSeq = await allocateUserSeq(userId);
        const updatePayload = isUpdate
            ? buildPublicShareUpdatedUpdate(publicShare, updateSeq, randomKeyNaked(12))
            : buildPublicShareCreatedUpdate(publicShare, updateSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId: userId,
            payload: updatePayload,
            recipientFilter: { type: 'all-interested-in-session', sessionId }
        });

        return reply.send({
            publicShare: {
                id: publicShare.id,
                token: publicShare.token,
                expiresAt: publicShare.expiresAt?.getTime() ?? null,
                maxUses: publicShare.maxUses,
                useCount: publicShare.useCount,
                isConsentRequired: publicShare.isConsentRequired,
                createdAt: publicShare.createdAt.getTime(),
                updatedAt: publicShare.updatedAt.getTime()
            }
        });
    });

    /**
     * Get public share info for a session
     */
    app.get('/v1/sessions/:sessionId/public-share', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Only owner can view public share settings
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId }
        });

        if (!publicShare) {
            return reply.send({ publicShare: null });
        }

        return reply.send({
            publicShare: {
                id: publicShare.id,
                token: publicShare.token,
                expiresAt: publicShare.expiresAt?.getTime() ?? null,
                maxUses: publicShare.maxUses,
                useCount: publicShare.useCount,
                isConsentRequired: publicShare.isConsentRequired,
                createdAt: publicShare.createdAt.getTime(),
                updatedAt: publicShare.updatedAt.getTime()
            }
        });
    });

    /**
     * Delete public share (disable public link)
     */
    app.delete('/v1/sessions/:sessionId/public-share', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Only owner can delete public share
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        // Use transaction to ensure consistent state
        const deleted = await db.$transaction(async (tx) => {
            // Check if share exists
            const existing = await tx.publicSessionShare.findUnique({
                where: { sessionId }
            });

            if (!existing) {
                return false;
            }

            // Delete public share
            await tx.publicSessionShare.delete({
                where: { sessionId }
            });

            return true;
        });

        // Emit real-time update to session owner (outside transaction)
        if (deleted) {
            const updateSeq = await allocateUserSeq(userId);
            const updatePayload = buildPublicShareDeletedUpdate(
                sessionId,
                updateSeq,
                randomKeyNaked(12)
            );

            eventRouter.emitUpdate({
                userId: userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });
        }

        return reply.send({ success: true });
    });

    /**
     * Access session via public share token (no auth required)
     *
     * If isConsentRequired is true, client must pass consent=true query param
     */
    app.get('/v1/public-share/:token', {
        schema: {
            params: z.object({
                token: z.string()
            }),
            querystring: z.object({
                consent: z.coerce.boolean().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const { token } = request.params;
        const { consent } = request.query || {};

        // Try to get user ID if authenticated
        let userId: string | null = null;
        if (request.headers.authorization) {
            try {
                await app.authenticate(request, reply);
                userId = request.userId;
            } catch {
                // Not authenticated, continue as anonymous
            }
        }

        // Use transaction to atomically check limits and increment use count
        const result = await db.$transaction(async (tx) => {
            // Check access and get full public share data
            const publicShare = await tx.publicSessionShare.findUnique({
                where: { token },
                select: {
                    id: true,
                    sessionId: true,
                    expiresAt: true,
                    maxUses: true,
                    useCount: true,
                    isConsentRequired: true,
                    encryptedDataKey: true,
                    blockedUsers: userId ? {
                        where: { userId },
                        select: { id: true }
                    } : undefined
                }
            });

            if (!publicShare) {
                return { error: 'Public share not found or expired' };
            }

            // Check if expired
            if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
                return { error: 'Public share not found or expired' };
            }

            // Check if max uses exceeded (before incrementing)
            if (publicShare.maxUses && publicShare.useCount >= publicShare.maxUses) {
                return { error: 'Public share not found or expired' };
            }

            // Check if user is blocked
            if (userId && publicShare.blockedUsers && publicShare.blockedUsers.length > 0) {
                return { error: 'Public share not found or expired' };
            }

            // Check consent requirement
            if (publicShare.isConsentRequired && !consent) {
                return {
                    error: 'Consent required',
                    requiresConsent: true,
                    publicShareId: publicShare.id
                };
            }

            // Increment use count atomically
            await tx.publicSessionShare.update({
                where: { id: publicShare.id },
                data: { useCount: { increment: 1 } }
            });

            return {
                success: true,
                publicShareId: publicShare.id,
                sessionId: publicShare.sessionId,
                isConsentRequired: publicShare.isConsentRequired,
                encryptedDataKey: publicShare.encryptedDataKey
            };
        });

        // Handle errors from transaction
        if ('error' in result) {
            if (result.requiresConsent) {
                return reply.code(403).send({
                    error: result.error,
                    requiresConsent: true
                });
            }
            return reply.code(404).send({ error: result.error });
        }

        // Log access (only log IP/UA if consent was given)
        const ipAddress = result.isConsentRequired ? getIpAddress(request.headers) : undefined;
        const userAgent = result.isConsentRequired ? getUserAgent(request.headers) : undefined;
        await logPublicShareAccess(result.publicShareId, userId, ipAddress, userAgent);

        // Get session info
        const session = await db.session.findUnique({
            where: { id: result.sessionId },
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
                agentStateVersion: session.agentStateVersion
            },
            accessLevel: 'view',
            encryptedDataKey: Buffer.from(result.encryptedDataKey).toString('base64')
        });
    });

    /**
     * Get blocked users for public share
     */
    app.get('/v1/sessions/:sessionId/public-share/blocked-users', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Only owner can view blocked users
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (!publicShare) {
            return reply.code(404).send({ error: 'Public share not found' });
        }

        const blockedUsers = await db.publicShareBlockedUser.findMany({
            where: { publicShareId: publicShare.id },
            include: {
                user: {
                    select: PROFILE_SELECT
                }
            },
            orderBy: { blockedAt: 'desc' }
        });

        return reply.send({
            blockedUsers: blockedUsers.map(bu => ({
                id: bu.id,
                user: bu.user,
                reason: bu.reason,
                blockedAt: bu.blockedAt.getTime()
            }))
        });
    });

    /**
     * Block user from public share
     */
    app.post('/v1/sessions/:sessionId/public-share/blocked-users', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                userId: z.string(),
                reason: z.string().optional()
            })
        }
    }, async (request, reply) => {
        const ownerId = request.userId;
        const { sessionId } = request.params;
        const { userId, reason } = request.body;

        // Only owner can block users
        if (!await isSessionOwner(ownerId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (!publicShare) {
            return reply.code(404).send({ error: 'Public share not found' });
        }

        const blockedUser = await db.publicShareBlockedUser.create({
            data: {
                publicShareId: publicShare.id,
                userId,
                reason: reason ?? null
            },
            include: {
                user: {
                    select: PROFILE_SELECT
                }
            }
        });

        return reply.send({
            blockedUser: {
                id: blockedUser.id,
                user: blockedUser.user,
                reason: blockedUser.reason,
                blockedAt: blockedUser.blockedAt.getTime()
            }
        });
    });

    /**
     * Unblock user from public share
     */
    app.delete('/v1/sessions/:sessionId/public-share/blocked-users/:blockedUserId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                blockedUserId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, blockedUserId } = request.params;

        // Only owner can unblock users
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        await db.publicShareBlockedUser.delete({
            where: { id: blockedUserId }
        });

        return reply.send({ success: true });
    });

    /**
     * Get access logs for public share
     */
    app.get('/v1/sessions/:sessionId/public-share/access-logs', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).default(50)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const limit = request.query?.limit || 50;

        // Only owner can view access logs
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (!publicShare) {
            return reply.code(404).send({ error: 'Public share not found' });
        }

        const logs = await db.publicShareAccessLog.findMany({
            where: { publicShareId: publicShare.id },
            include: {
                user: {
                    select: PROFILE_SELECT
                }
            },
            orderBy: { accessedAt: 'desc' },
            take: limit
        });

        return reply.send({
            logs: logs.map(log => ({
                id: log.id,
                user: log.user || null,
                accessedAt: log.accessedAt.getTime(),
                ipAddress: log.ipAddress,
                userAgent: log.userAgent
            }))
        });
    });
}
