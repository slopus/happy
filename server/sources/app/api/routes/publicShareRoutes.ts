import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { isSessionOwner, checkPublicShareAccess } from "@/app/share/accessControl";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { logPublicShareAccess, getIpAddress, getUserAgent } from "@/app/share/accessLogger";
import { PROFILE_SELECT } from "@/app/share/types";

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

        await db.publicSessionShare.delete({
            where: { sessionId }
        }).catch(() => {
            // Ignore if doesn't exist
        });

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

        const access = await checkPublicShareAccess(token, userId);
        if (!access) {
            return reply.code(404).send({ error: 'Public share not found or expired' });
        }

        // Check if consent is required and get encrypted key
        const publicShare = await db.publicSessionShare.findUnique({
            where: { id: access.publicShareId },
            select: {
                isConsentRequired: true,
                encryptedDataKey: true
            }
        });

        if (publicShare?.isConsentRequired && !consent) {
            return reply.code(403).send({
                error: 'Consent required',
                requiresConsent: true
            });
        }

        // Log access (only log IP/UA if consent was given)
        const ipAddress = publicShare?.isConsentRequired ? getIpAddress(request.headers) : undefined;
        const userAgent = publicShare?.isConsentRequired ? getUserAgent(request.headers) : undefined;
        await logPublicShareAccess(access.publicShareId, userId, ipAddress, userAgent);

        // Increment use count
        await db.publicSessionShare.update({
            where: { id: access.publicShareId },
            data: { useCount: { increment: 1 } }
        });

        // Get session info
        const session = await db.session.findUnique({
            where: { id: access.sessionId },
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
            encryptedDataKey: publicShare ? Buffer.from(publicShare.encryptedDataKey).toString('base64') : null
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
