import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { dispatchSessionEventPush } from "@/app/push/pushDispatch";
import { buildSessionEventEphemeral, eventRouter } from "@/app/events/eventRouter";

export function pushRoutes(app: Fastify) {
    
    // Push Token Registration API
    app.post('/v1/push-tokens', {
        schema: {
            body: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to register push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.body;

        try {
            await db.accountPushToken.upsert({
                where: {
                    accountId_token: {
                        accountId: userId,
                        token: token
                    }
                },
                update: {
                    updatedAt: new Date()
                },
                create: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to register push token' });
        }
    });

    // Delete Push Token API
    app.delete('/v1/push-tokens/:token', {
        schema: {
            params: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to delete push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.params;

        try {
            await db.accountPushToken.deleteMany({
                where: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Session-Event Push API
    // CLI/daemon clients call this instead of talking to Expo directly so the
    // server can apply presence-based suppression (active desktop/web/mobile).
    app.post('/v1/sessions/:sessionId/push-event', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                kind: z.enum(['done', 'permission', 'question']),
                title: z.string().min(1).max(200),
                body: z.string().min(1).max(500),
                data: z.record(z.string(), z.unknown()).optional()
            }),
            response: {
                // `result` reports what actually happened so callers can tell a
                // delivered push from a suppressed one. `success` stays for
                // older clients that only check it.
                200: z.object({
                    success: z.literal(true),
                    result: z.enum(['sent', 'partial', 'suppressed', 'no_tokens', 'failed']),
                    tokens: z.number().optional(),
                    delivered: z.number().optional(),
                    reason: z.string().optional()
                }),
                404: z.object({
                    error: z.literal('Session not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { kind, title, body, data } = request.body;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Fan out the event to user's connected clients (web tabs use this to
        // bump tab-title unread counter for "user attention needed" moments only,
        // instead of pinging on every encrypted message).
        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionEventEphemeral(sessionId, kind, title, body),
            recipientFilter: { type: 'all-interested-in-session', sessionId }
        });

        // Awaited so the response can report the real outcome. The CLI sends
        // this fire-and-forget, so the extra latency never blocks a turn.
        const outcome = await dispatchSessionEventPush({
            userId,
            sessionId,
            title,
            body,
            data: { ...(data ?? {}), kind }
        });

        return reply.send({ success: true, ...outcome });
    });

    // Get Push Tokens API
    app.get('/v1/push-tokens', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const tokens = await db.accountPushToken.findMany({
                where: {
                    accountId: userId
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            return reply.send({
                tokens: tokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime()
                }))
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}