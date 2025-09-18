import { db } from "@/storage/db";
import { Account, RelationshipStatus, UserRelationship } from "@prisma/client";
import { getPublicUrl } from "@/storage/files";
import { GitHubProfile } from "@/app/api/types";

export interface UserProfile {
    id: string;
    firstName: string;
    lastName: string | null;
    avatar: {
        path: string;
        url: string;
        width?: number;
        height?: number;
        thumbhash?: string;
    } | null;
    username: string;
}

export class FriendshipService {
    /**
     * Build user profile from account data
     */
    static buildUserProfile(account: Account & {
        githubUser?: {
            profile: any;
        } | null;
        avatar?: any;
    }): UserProfile {
        const githubProfile = account.githubUser?.profile as GitHubProfile | undefined;
        
        return {
            id: account.id,
            firstName: account.firstName || '',
            lastName: account.lastName,
            avatar: account.avatar ? {
                ...account.avatar,
                url: getPublicUrl(account.avatar.path)
            } : null,
            username: githubProfile?.login || ''
        };
    }

    /**
     * Get multiple user profiles by IDs
     */
    static async getUserProfiles(userIds: string[]): Promise<UserProfile[]> {
        if (userIds.length === 0) {
            return [];
        }

        const accounts = await db.account.findMany({
            where: {
                id: { in: userIds },
                githubUserId: { not: null }
            },
            include: {
                githubUser: true
            }
        });

        return accounts.map(account => this.buildUserProfile(account));
    }

    /**
     * Search for a user by exact username match
     */
    static async searchUserByUsername(username: string): Promise<UserProfile | null> {
        const githubUser = await db.githubUser.findFirst({
            where: {
                profile: {
                    path: ['login'],
                    equals: username
                }
            }
        });

        if (!githubUser) {
            return null;
        }

        const account = await db.account.findFirst({
            where: {
                githubUserId: githubUser.id
            },
            include: {
                githubUser: true
            }
        });

        if (!account) {
            return null;
        }

        return this.buildUserProfile(account);
    }

    /**
     * Send a friend request from one user to another
     */
    static async sendFriendRequest(fromUserId: string, toUserId: string): Promise<UserRelationship> {
        // Verify both users exist and have GitHub connected
        const [fromUser, toUser] = await Promise.all([
            db.account.findFirst({
                where: { id: fromUserId, githubUserId: { not: null } }
            }),
            db.account.findFirst({
                where: { id: toUserId, githubUserId: { not: null } }
            })
        ]);

        if (!fromUser || !toUser) {
            throw new Error('Both users must exist and have GitHub connected');
        }

        // Check if relationship already exists
        const existing = await db.userRelationship.findUnique({
            where: {
                fromUserId_toUserId: {
                    fromUserId,
                    toUserId
                }
            }
        });

        if (existing) {
            if (existing.status === RelationshipStatus.rejected) {
                // Allow re-sending if previously rejected
                return await db.userRelationship.update({
                    where: {
                        fromUserId_toUserId: {
                            fromUserId,
                            toUserId
                        }
                    },
                    data: {
                        status: RelationshipStatus.pending,
                        updatedAt: new Date()
                    }
                });
            }
            throw new Error('Friend request already exists');
        }

        // Create new friend request
        return await db.userRelationship.create({
            data: {
                fromUserId,
                toUserId,
                status: RelationshipStatus.pending
            }
        });
    }

    /**
     * Accept a friend request
     */
    static async acceptFriendRequest(fromUserId: string, toUserId: string): Promise<{
        relationship: UserRelationship;
        reverseRelationship: UserRelationship;
    }> {
        // Verify the request exists and is pending
        const request = await db.userRelationship.findUnique({
            where: {
                fromUserId_toUserId: {
                    fromUserId,
                    toUserId
                }
            }
        });

        if (!request || request.status !== RelationshipStatus.pending) {
            throw new Error('No pending friend request found');
        }

        // Use transaction to ensure both operations succeed
        const result = await db.$transaction(async (tx) => {
            // Update original request to accepted
            const relationship = await tx.userRelationship.update({
                where: {
                    fromUserId_toUserId: {
                        fromUserId,
                        toUserId
                    }
                },
                data: {
                    status: RelationshipStatus.accepted,
                    acceptedAt: new Date()
                }
            });

            // Create reverse relationship
            const reverseRelationship = await tx.userRelationship.create({
                data: {
                    fromUserId: toUserId,
                    toUserId: fromUserId,
                    status: RelationshipStatus.accepted,
                    acceptedAt: new Date()
                }
            });

            return { relationship, reverseRelationship };
        });

        return result;
    }

    /**
     * Reject a friend request
     */
    static async rejectFriendRequest(fromUserId: string, toUserId: string): Promise<UserRelationship> {
        const request = await db.userRelationship.findUnique({
            where: {
                fromUserId_toUserId: {
                    fromUserId,
                    toUserId
                }
            }
        });

        if (!request || request.status !== RelationshipStatus.pending) {
            throw new Error('No pending friend request found');
        }

        return await db.userRelationship.update({
            where: {
                fromUserId_toUserId: {
                    fromUserId,
                    toUserId
                }
            },
            data: {
                status: RelationshipStatus.rejected
            }
        });
    }

    /**
     * Remove a friendship (both directions)
     */
    static async removeFriend(userId: string, friendId: string): Promise<boolean> {
        await db.$transaction([
            db.userRelationship.deleteMany({
                where: {
                    OR: [
                        { fromUserId: userId, toUserId: friendId },
                        { fromUserId: friendId, toUserId: userId }
                    ]
                }
            })
        ]);

        return true;
    }

    /**
     * Get all pending friend requests for a user
     */
    static async getPendingRequests(userId: string): Promise<Array<UserRelationship & {
        fromUser: UserProfile;
    }>> {
        const requests = await db.userRelationship.findMany({
            where: {
                toUserId: userId,
                status: RelationshipStatus.pending
            },
            include: {
                fromUser: {
                    include: {
                        githubUser: true
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        return requests.map(request => ({
            ...request,
            fromUser: this.buildUserProfile(request.fromUser)
        }));
    }

    /**
     * Get all friends (mutual accepted relationships)
     */
    static async getFriends(userId: string): Promise<UserProfile[]> {
        // Find all accepted relationships where user is either fromUser or toUser
        const relationships = await db.userRelationship.findMany({
            where: {
                AND: [
                    { fromUserId: userId },
                    { status: RelationshipStatus.accepted }
                ]
            },
            include: {
                toUser: {
                    include: {
                        githubUser: true
                    }
                }
            }
        });

        // Check for mutual relationships
        const friendIds = new Set<string>();
        for (const rel of relationships) {
            // Check if reverse relationship exists and is accepted
            const reverseRel = await db.userRelationship.findUnique({
                where: {
                    fromUserId_toUserId: {
                        fromUserId: rel.toUserId,
                        toUserId: userId
                    }
                }
            });

            if (reverseRel && reverseRel.status === RelationshipStatus.accepted) {
                friendIds.add(rel.toUserId);
            }
        }

        if (friendIds.size === 0) {
            return [];
        }

        const friends = await db.account.findMany({
            where: {
                id: { in: Array.from(friendIds) }
            },
            include: {
                githubUser: true
            }
        });

        return friends.map(friend => this.buildUserProfile(friend));
    }

    /**
     * Remove all relationships when GitHub is disconnected
     */
    static async removeAllRelationships(userId: string): Promise<void> {
        await db.userRelationship.deleteMany({
            where: {
                OR: [
                    { fromUserId: userId },
                    { toUserId: userId }
                ]
            }
        });
    }

    /**
     * Check if a user has GitHub connected
     */
    static async hasGitHubConnected(userId: string): Promise<boolean> {
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { githubUserId: true }
        });

        return !!account?.githubUserId;
    }
}