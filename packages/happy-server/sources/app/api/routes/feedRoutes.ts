import { z } from "zod";
import { Fastify } from "../types";
import { FeedBodySchema } from "@/app/feed/types";
import { feedGet } from "@/app/feed/feedGet";
import { Context } from "@/context";
import { db } from "@/storage/db";

export function feedRoutes(app: Fastify) {
    app.get('/v1/feed', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                before: z.string().optional(),
                after: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }).optional(),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        id: z.string(),
                        body: FeedBodySchema,
                        repeatKey: z.string().nullable(),
                        badge: z.boolean(),
                        meta: z.record(z.unknown()).nullable(),
                        cursor: z.string(),
                        createdAt: z.number()
                    })),
                    hasMore: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const items = await feedGet(db, Context.create(request.userId), {
            cursor: {
                before: request.query?.before,
                after: request.query?.after
            },
            limit: request.query?.limit
        });
        return reply.send({ items: items.items, hasMore: items.hasMore });
    });

    app.patch('/v1/feed/:id/read', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({ ok: z.boolean() })
            }
        }
    }, async (request, reply) => {
        await db.userFeedItem.updateMany({
            where: {
                id: request.params.id,
                userId: request.userId
            },
            data: { badge: false }
        });
        return reply.send({ ok: true });
    });

    app.delete('/v1/feed/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({ ok: z.boolean() })
            }
        }
    }, async (request, reply) => {
        await db.userFeedItem.deleteMany({
            where: {
                id: request.params.id,
                userId: request.userId
            }
        });
        return reply.send({ ok: true });
    });
}