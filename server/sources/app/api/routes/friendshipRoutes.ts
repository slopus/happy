import { z } from "zod";
import { Fastify } from "../types";
import { EventRouter, buildRelationshipUpdatedEvent } from "@/app/events/eventRouter";
import { FriendshipService } from "@/services/friendshipService";
import { log } from "@/utils/log";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";

// Shared Zod Schemas

const RelationshipStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'removed']);
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

const RelationshipSchema = z.object({
    fromUserId: z.string(),
    toUserId: z.string(),
    status: RelationshipStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    acceptedAt: z.string().nullable()
});

export function friendshipRoutes(app: Fastify, eventRouter: EventRouter) {
    
    // Get multiple user profiles
    app.get('/v1/profiles', {
        schema: {
            querystring: z.object({
                userIds: z.string() // Comma-separated list
            }),
            response: {
                200: z.object({
                    profiles: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { userIds } = request.query;
        const userIdArray = userIds.split(',').filter(id => id.trim());
        
        try {
            const profiles = await FriendshipService.getUserProfiles(userIdArray, request.userId);
            return reply.send({ profiles });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get profiles: ${error}`);
            return reply.code(500).send({ profiles: [] });
        }
    });

    // Search user by username
    app.get('/v1/profiles/search', {
        schema: {
            querystring: z.object({
                username: z.string()
            }),
            response: {
                200: z.object({
                    profile: UserProfileSchema.nullable()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { username } = request.query;
        
        try {
            const profile = await FriendshipService.searchUserByUsername(username, request.userId);
            return reply.send({ profile });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to search user: ${error}`);
            return reply.send({ profile: null });
        }
    });

    // Send friend request
    app.post('/v1/friends/request', {
        schema: {
            body: z.object({
                recipientId: z.string()
            }),
            response: {
                200: z.object({ profile: UserProfileSchema.nullable() }),
                400: z.object({ error: z.string() })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { recipientId } = request.body;

        if (userId === recipientId) {
            return reply.code(400).send({ error: 'Cannot send friend request to yourself' });
        }

        try {
            // Check if both users have GitHub connected
            const [hasGitHub, recipientHasGitHub] = await Promise.all([
                FriendshipService.hasGitHubConnected(userId),
                FriendshipService.hasGitHubConnected(recipientId)
            ]);

            if (!hasGitHub || !recipientHasGitHub) {
                return reply.send({ profile: null });
            }

            const profile = await FriendshipService.sendFriendRequest(userId, recipientId);

            // Get profiles (relative to recipient) for the socket event
            const [fromUserProfile, toUserProfile] = await FriendshipService.getUserProfiles([userId, recipientId], recipientId);

            // Emit socket event to recipient
            const updateSeq = await allocateUserSeq(recipientId);
            const updatePayload = buildRelationshipUpdatedEvent(
                {
                    fromUserId: userId,
                    toUserId: recipientId,
                    status: 'pending',
                    action: 'created',
                    fromUser: fromUserProfile,
                    toUser: toUserProfile,
                    timestamp: Date.now()
                },
                updateSeq,
                randomKeyNaked(12)
            );

            eventRouter.emitUpdate({
                userId: recipientId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ profile });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to send friend request: ${error}`);
            return reply.send({ profile: null });
        }
    });

    // Respond to friend request
    app.post('/v1/friends/respond', {
        schema: {
            body: z.object({
                fromUserId: z.string(),
                toUserId: z.string(),
                accept: z.boolean()
            }),
            response: {
                200: z.object({ profile: UserProfileSchema.nullable() }),
                400: z.object({ error: z.string() })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { fromUserId, toUserId, accept } = request.body;

        // Verify the user is the recipient of the request
        if (toUserId !== userId) {
            return reply.code(403).send({ error: 'You can only respond to requests sent to you' });
        }

        try {
            if (accept) {
                const profile = await FriendshipService.acceptFriendRequest(fromUserId, toUserId);

                // Emit socket event to both users with status accepted
                for (const targetUserId of [fromUserId, toUserId]) {
                    const [fromUserProfile, toUserProfile] = await FriendshipService.getUserProfiles([fromUserId, toUserId], targetUserId);
                    const updateSeq = await allocateUserSeq(targetUserId);
                    const updatePayload = buildRelationshipUpdatedEvent(
                        {
                            fromUserId,
                            toUserId,
                            status: 'accepted',
                            action: 'updated',
                            fromUser: fromUserProfile,
                            toUser: toUserProfile,
                            timestamp: Date.now()
                        },
                        updateSeq,
                        randomKeyNaked(12)
                    );

                    eventRouter.emitUpdate({
                        userId: targetUserId,
                        payload: updatePayload,
                        recipientFilter: { type: 'user-scoped-only' }
                    });
                }

                return reply.send({ profile });
            } else {
                const profile = await FriendshipService.rejectFriendRequest(fromUserId, toUserId);
                // No socket event for rejections (hidden from requestor)
                return reply.send({ profile });
            }
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to respond to friend request: ${error}`);
            return reply.send({ profile: null });
        }
    });

    // Get pending friend requests
    app.get('/v1/friends/requests', {
        schema: {
            response: {
                200: z.object({
                    requests: z.array(z.object({
                        fromUserId: z.string(),
                        toUserId: z.string(),
                        status: RelationshipStatusSchema,
                        fromUser: UserProfileSchema,
                        createdAt: z.string()
                    }))
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const requests = await FriendshipService.getPendingRequests(userId);
            
            return reply.send({
                requests: requests.map(req => ({
                    fromUserId: req.fromUserId,
                    toUserId: req.toUserId,
                    status: req.status as any,
                    fromUser: req.fromUser,
                    createdAt: req.createdAt.toISOString()
                }))
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get pending requests: ${error}`);
            return reply.send({ requests: [] });
        }
    });

    // Get friends list
    app.get('/v1/friends/list', {
        schema: {
            response: {
                200: z.object({
                    friends: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const friends = await FriendshipService.getFriends(userId);
            return reply.send({ friends });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get friends: ${error}`);
            return reply.send({ friends: [] });
        }
    });

    // Remove friend
    app.delete('/v1/friends/:friendId', {
        schema: {
            params: z.object({
                friendId: z.string()
            }),
            response: {
                200: z.object({ profile: UserProfileSchema.nullable() })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { friendId } = request.params;

        try {
            const profile = await FriendshipService.removeFriend(userId, friendId);

            // Get profiles for the socket event
            const [userProfile] = await FriendshipService.getUserProfiles([userId], friendId);

            // Emit socket event to the friend
            const updateSeq = await allocateUserSeq(friendId);
            const updatePayload = buildRelationshipUpdatedEvent(
                {
                    fromUserId: userId,
                    toUserId: friendId,
                    status: 'removed',
                    action: 'deleted',
                    fromUser: userProfile,
                    timestamp: Date.now()
                },
                updateSeq,
                randomKeyNaked(12)
            );

            eventRouter.emitUpdate({
                userId: friendId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ profile });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to remove friend: ${error}`);
            return reply.send({ profile: null });
        }
    });
}
