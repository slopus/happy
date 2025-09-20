import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";
import { getPublicUrl } from "@/storage/files";
import { friendAdd } from "@/app/social/friendAdd";
import { Context } from "@/context";
import { friendRemove } from "@/app/social/friendRemove";
import { friendList } from "@/app/social/friendList";

export async function userRoutes(app: Fastify) {

    // Get user profile
    app.get('/v1/user/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { id } = request.params;

        // Fetch user
        const user = await db.account.findUnique({
            where: {
                id: id
            },
            include: {
                githubUser: true
            }
        });

        if (!user || !user.githubUser) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Resolve relationship status
        const relationship = await db.userRelationship.findFirst({
            where: {
                fromUserId: request.userId,
                toUserId: id
            }
        });
        const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;

        // Build user profile
        return reply.send({
            user: {
                id: user.id,
                firstName: user.firstName || '',
                lastName: user.lastName,
                avatar: user.avatar ? {
                    path: user.avatar.path,
                    url: getPublicUrl(user.avatar.path),
                    width: user.avatar.width,
                    height: user.avatar.height,
                    thumbhash: user.avatar.thumbhash
                } : null,
                username: user.githubUser.profile.login,
                status: status
            }
        });
    });

    // Search for user
    app.get('/v1/user/search', {
        schema: {
            querystring: z.object({
                query: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { query } = request.query;

        // Search for user
        const user = await db.account.findFirst({
            where: {
                githubUser: {
                    profile: {
                        path: ['login'],
                        equals: query
                    }
                }
            },
            include: {
                githubUser: true
            }
        });

        if (!user || !user.githubUser) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Resolve relationship status
        const relationship = await db.userRelationship.findFirst({
            where: {
                fromUserId: request.userId,
                toUserId: user.id
            }
        });
        const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;

        return reply.send({
            user: {
                id: user.id,
                firstName: user.firstName || '',
                lastName: user.lastName,
                avatar: user.avatar ? {
                    path: user.avatar.path,
                    url: getPublicUrl(user.avatar.path),
                    width: user.avatar.width,
                    height: user.avatar.height,
                    thumbhash: user.avatar.thumbhash
                } : null,
                username: user.githubUser.profile.login,
                status: status
            }
        });
    });

    // Add friend
    app.post('/v1/friends/add', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const user = await friendAdd(Context.create(request.userId), request.body.uid);
        if (!user) {
            return reply.code(404).send({ error: 'User not found' });
        }
        return reply.send({ user });
    });

    app.post('/v1/friends/remove', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const user = await friendRemove(Context.create(request.userId), request.body.uid);
        if (!user) {
            return reply.code(404).send({ error: 'User not found' });
        }
        return reply.send({ user });
    });

    app.get('/v1/friends', {
        schema: {
            response: {
                200: z.object({
                    friends: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const friends = await friendList(Context.create(request.userId));
        return reply.send({ friends });
    });
};

// Shared Zod Schemas
const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
const UserProfileSchema = z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
        path: z.string(),
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    status: RelationshipStatusSchema
});