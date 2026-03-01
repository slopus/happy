import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";

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

    // Increment badge count and return new value (called by CLI before sending push)
    app.post('/v1/badge/increment', {
        schema: {
            response: {
                200: z.object({
                    badgeCount: z.number()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const account = await db.account.update({
            where: { id: userId },
            data: { badgeCount: { increment: 1 } },
            select: { badgeCount: true }
        });
        return reply.send({ badgeCount: account.badgeCount });
    });

    // Reset badge count to zero (called by App when user opens or backgrounds the app)
    app.post('/v1/badge/reset', {
        schema: {
            response: {
                200: z.object({
                    success: z.literal(true)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        await db.account.update({
            where: { id: userId },
            data: { badgeCount: 0 }
        });
        return reply.send({ success: true });
    });
}