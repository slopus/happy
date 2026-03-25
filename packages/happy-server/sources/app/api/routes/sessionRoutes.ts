import { eventRouter, buildNewSessionUpdate } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db, getPGlite } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";
import {
    buildSessionSyncNodeClaims,
    canAccessSession,
    isAccountScopedSyncNodeToken,
    ServerSyncNodeTokenClaimsSchema,
} from "@/app/auth/syncNodeToken";
import { auth } from "@/app/auth/auth";

const legacyCreateSessionBodySchema = z.object({
    tag: z.string(),
    metadata: z.string(),
    agentState: z.string().nullish(),
    dataEncryptionKey: z.string().nullish(),
});

const syncNodeCreateSessionBodySchema = z.object({
    directory: z.string(),
    projectID: z.string(),
    title: z.string().optional(),
    parentID: z.string().optional(),
    dataEncryptionKey: z.string().nullish(),
});

const createSessionBodySchema = z.union([
    legacyCreateSessionBodySchema,
    syncNodeCreateSessionBodySchema,
]);

type SessionRouteRow = {
    id: string;
    seq: number;
    createdAt: Date | string | number;
    updatedAt: Date | string | number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date | string | number;
};

function toTimestamp(value: Date | string | number): number {
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toDate(value: Date | string | number): Date {
    return value instanceof Date ? value : new Date(value);
}

function encodeDataEncryptionKey(value: Uint8Array | null): string | null {
    if (value == null) {
        return null;
    }
    return Buffer.from(value).toString('base64');
}

function toNewSessionUpdateInput(session: SessionRouteRow): Parameters<typeof buildNewSessionUpdate>[0] {
    return {
        ...session,
        createdAt: toDate(session.createdAt),
        updatedAt: toDate(session.updatedAt),
        lastActiveAt: toDate(session.lastActiveAt),
    };
}

function toSessionResponse(session: SessionRouteRow) {
    return {
        id: session.id,
        seq: session.seq,
        createdAt: toTimestamp(session.createdAt),
        updatedAt: toTimestamp(session.updatedAt),
        active: session.active,
        activeAt: toTimestamp(session.lastActiveAt),
        metadata: session.metadata,
        metadataVersion: session.metadataVersion,
        agentState: session.agentState,
        agentStateVersion: session.agentStateVersion,
        dataEncryptionKey: encodeDataEncryptionKey(session.dataEncryptionKey),
        lastMessage: null,
    };
}

export function sessionRoutes(app: Fastify) {

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        if (!isAccountScopedSyncNodeToken(request.syncNodeClaims)) {
            return reply.code(403).send({ error: 'Account-scoped token required' });
        }

        const userId = request.userId;

        const pglite = getPGlite();
        if (pglite) {
            const result = await pglite.query<SessionRouteRow>(`
                SELECT
                    "id",
                    "seq",
                    "createdAt",
                    "updatedAt",
                    "metadata",
                    "metadataVersion",
                    "agentState",
                    "agentStateVersion",
                    "dataEncryptionKey",
                    "active",
                    "lastActiveAt"
                FROM "Session"
                WHERE "accountId" = $1
                ORDER BY "updatedAt" DESC
                LIMIT 150
            `, [userId]);

            return reply.send({
                sessions: result.rows.map(toSessionResponse),
            });
        }

        const sessions = await db.session.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' },
            take: 150,
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
                lastActiveAt: true,
                // messages: {
                //     orderBy: { seq: 'desc' },
                //     take: 1,
                //     select: {
                //         id: true,
                //         seq: true,
                //         content: true,
                //         localId: true,
                //         createdAt: true
                //     }
                // }
            }
        });

        return reply.send({
            sessions: sessions.map((session) => toSessionResponse(session)),
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        if (!isAccountScopedSyncNodeToken(request.syncNodeClaims)) {
            return reply.code(403).send({ error: 'Account-scoped token required' });
        }

        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
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
                lastActiveAt: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional()
            }).optional()
        }
    }, async (request, reply) => {
        if (!isAccountScopedSyncNodeToken(request.syncNodeClaims)) {
            return reply.code(403).send({ error: 'Account-scoped token required' });
        }

        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { accountId: userId };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
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
                lastActiveAt: true,
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            })),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: createSessionBodySchema
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        if (!isAccountScopedSyncNodeToken(request.syncNodeClaims)) {
            return reply.code(403).send({ error: 'Account-scoped token required' });
        }

        const userId = request.userId;
        const body = request.body;

        const isLegacyCreate = 'tag' in body;
        const tag = isLegacyCreate ? body.tag : `sync-node:${randomKeyNaked(16)}`;
        const metadata = isLegacyCreate
            ? body.metadata
            : JSON.stringify({
                directory: body.directory,
                projectID: body.projectID,
                title: body.title ?? 'New Session',
                parentID: body.parentID ?? null,
            });
        const agentState = isLegacyCreate ? body.agentState ?? null : null;
        const dataEncryptionKey = body.dataEncryptionKey ?? null;
        const pglite = getPGlite();

        if (isLegacyCreate) {
            if (pglite) {
                const existingResult = await pglite.query<SessionRouteRow>(`
                    SELECT
                        "id",
                        "seq",
                        "createdAt",
                        "updatedAt",
                        "metadata",
                        "metadataVersion",
                        "agentState",
                        "agentStateVersion",
                        "dataEncryptionKey",
                        "active",
                        "lastActiveAt"
                    FROM "Session"
                    WHERE "accountId" = $1 AND "tag" = $2
                    LIMIT 1
                `, [userId, tag]);

                const existingSession = existingResult.rows[0];
                if (existingSession) {
                    log({ module: 'session-create', sessionId: existingSession.id, userId, tag }, `Found existing session: ${existingSession.id} for tag ${tag}`);
                    return reply.send({
                        id: existingSession.id,
                        session: toSessionResponse(existingSession),
                    });
                }
            }

            const existingSession = await db.session.findFirst({
                where: {
                    accountId: userId,
                    tag,
                }
            });
            if (existingSession) {
                log({ module: 'session-create', sessionId: existingSession.id, userId, tag }, `Found existing session: ${existingSession.id} for tag ${tag}`);
                return reply.send({
                    id: existingSession.id,
                    session: {
                        id: existingSession.id,
                        seq: existingSession.seq,
                        metadata: existingSession.metadata,
                        metadataVersion: existingSession.metadataVersion,
                        agentState: existingSession.agentState,
                        agentStateVersion: existingSession.agentStateVersion,
                        dataEncryptionKey: existingSession.dataEncryptionKey ? Buffer.from(existingSession.dataEncryptionKey).toString('base64') : null,
                        active: existingSession.active,
                        activeAt: existingSession.lastActiveAt.getTime(),
                        createdAt: existingSession.createdAt.getTime(),
                        updatedAt: existingSession.updatedAt.getTime(),
                        lastMessage: null
                    }
                });
            }
        }

        const updSeq = await allocateUserSeq(userId);
        const newSessionId = randomKeyNaked(24);

        log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
        const session = pglite
            ? (await pglite.query<SessionRouteRow>(`
                INSERT INTO "Session" (
                    "id",
                    "accountId",
                    "tag",
                    "metadata",
                    "agentState",
                    "dataEncryptionKey",
                    "updatedAt"
                ) VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    decode(CAST($6 AS text), 'base64'),
                    now()
                )
                RETURNING
                    "id",
                    "seq",
                    "createdAt",
                    "updatedAt",
                    "metadata",
                    "metadataVersion",
                    "agentState",
                    "agentStateVersion",
                    "dataEncryptionKey",
                    "active",
                    "lastActiveAt"
            `, [
                newSessionId,
                userId,
                tag,
                metadata,
                agentState,
                dataEncryptionKey,
            ])).rows[0]
            : await db.session.create({
                data: {
                    accountId: userId,
                    tag,
                    metadata,
                    agentState,
                    dataEncryptionKey: dataEncryptionKey ? Buffer.from(dataEncryptionKey, 'base64') : undefined,
                }
            });
        log({ module: 'session-create', sessionId: session.id, userId }, `Session created: ${session.id}`);

        const updatePayload = buildNewSessionUpdate(
            toNewSessionUpdateInput(session),
            updSeq,
            randomKeyNaked(12),
        );
        log({
            module: 'session-create',
            userId,
            sessionId: session.id,
            updateType: 'new-session',
            updatePayload: JSON.stringify(updatePayload)
        }, `Emitting new-session update to user-scoped connections`);
        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({
            id: session.id,
            session: toSessionResponse(session),
        });
    });

    app.post('/v1/sessions/:sessionId/token', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            response: {
                200: z.object({
                    token: z.string(),
                    claims: ServerSyncNodeTokenClaimsSchema,
                }),
                403: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                }),
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        if (!isAccountScopedSyncNodeToken(request.syncNodeClaims)) {
            return reply.code(403).send({ error: 'Account-scoped token required' });
        }

        const userId = request.userId;
        const { sessionId } = request.params;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId,
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const claims = buildSessionSyncNodeClaims(userId, sessionId);
        const token = await auth.createToken(userId, {
            syncNode: claims,
        });

        return reply.send({
            token,
            claims,
        });
    });

    app.post('/v1/sessions/:sessionId/stop', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        if (!isAccountScopedSyncNodeToken(request.syncNodeClaims)) {
            return reply.code(403).send({ error: 'Account-scoped token required' });
        }

        const userId = request.userId;
        const { sessionId } = request.params;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId,
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        await db.session.update({
            where: { id: sessionId },
            data: {
                active: false,
                lastActiveAt: new Date(),
            },
            select: { id: true },
        });

        return reply.send({ ok: true });
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        if (!canAccessSession(request.syncNodeClaims, sessionId)) {
            return reply.code(403).send({ error: 'Token cannot access requested session' });
        }

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        if (!isAccountScopedSyncNodeToken(request.syncNodeClaims)) {
            return reply.code(403).send({ error: 'Account-scoped token required' });
        }

        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
