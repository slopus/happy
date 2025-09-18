import { db } from "@/storage/db";
import type { Prisma, PrismaClient } from "@prisma/client";
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
    status: RelationshipStatus;
}

export class FriendshipService {
    private static isImageRefLike(value: unknown): value is { path: string; width?: number; height?: number; thumbhash?: string } {
        if (!value || typeof value !== 'object') return false;
        const v = value as Record<string, unknown>;
        return typeof v.path === 'string';
    }

    private static client(client?: Prisma.TransactionClient | PrismaClient) {
        return client ?? db;
    }

    private static async getStatusBetween(a: string, b: string, client?: Prisma.TransactionClient | PrismaClient): Promise<RelationshipStatus> {
        const c = this.client(client);
        const rels = await c.userRelationship.findMany({
            where: {
                OR: [
                    { fromUserId: a, toUserId: b },
                    { fromUserId: b, toUserId: a }
                ]
            }
        });
        if (rels.some(r => r.status === RelationshipStatus.accepted)) return RelationshipStatus.accepted;
        if (rels.some(r => r.status === RelationshipStatus.pending)) return RelationshipStatus.pending;
        if (rels.some(r => r.status === RelationshipStatus.rejected)) return RelationshipStatus.rejected;
        return RelationshipStatus.removed;
    }
    /**
     * Build user profile from account data
     */
    static buildUserProfile(
        account: Account & { githubUser?: { profile: GitHubProfile } | null },
        status: RelationshipStatus = RelationshipStatus.removed
    ): UserProfile {
        const githubProfile = account.githubUser?.profile;
        const avatarJson = account.avatar as Prisma.JsonValue | null;
        let avatar: UserProfile['avatar'] = null;
        if (this.isImageRefLike(avatarJson)) {
            avatar = {
                path: avatarJson.path,
                url: getPublicUrl(avatarJson.path),
                width: avatarJson.width,
                height: avatarJson.height,
                thumbhash: avatarJson.thumbhash
            };
        }

        return {
            id: account.id,
            firstName: account.firstName || '',
            lastName: account.lastName,
            avatar,
            username: githubProfile?.login || '',
            status
        };
    }

    /**
     * Get multiple user profiles by IDs
     */
    static async getUserProfiles(userIds: string[], relativeToUserId?: string): Promise<UserProfile[]> {
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

        let statusMap: Record<string, RelationshipStatus> = {};
        if (relativeToUserId) {
            const rels = await db.userRelationship.findMany({
                where: {
                    OR: [
                        { fromUserId: relativeToUserId, toUserId: { in: userIds } },
                        { fromUserId: { in: userIds }, toUserId: relativeToUserId }
                    ]
                }
            });
            const tmp: Record<string, RelationshipStatus[]> = {};
            for (const r of rels) {
                const otherId = r.fromUserId === relativeToUserId ? r.toUserId : r.fromUserId;
                (tmp[otherId] ||= []).push(r.status);
            }
            for (const [uid, statuses] of Object.entries(tmp)) {
                let s: RelationshipStatus = RelationshipStatus.removed;
                if (statuses.includes(RelationshipStatus.accepted)) s = RelationshipStatus.accepted;
                else if (statuses.includes(RelationshipStatus.pending)) s = RelationshipStatus.pending;
                else if (statuses.includes(RelationshipStatus.rejected)) s = RelationshipStatus.rejected;
                statusMap[uid] = s;
            }
        }

        return accounts.map(account => this.buildUserProfile(account, statusMap[account.id] ?? RelationshipStatus.removed));
    }

    /**
     * Search for a user by exact username match
     */
    static async searchUserByUsername(username: string, relativeToUserId?: string): Promise<UserProfile | null> {
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

        const status = relativeToUserId ? await this.getStatusBetween(relativeToUserId, account.id) : RelationshipStatus.removed;
        return this.buildUserProfile(account, status);
    }

    /**
     * Send a friend request from one user to another
     */
    static async sendFriendRequest(fromUserId: string, toUserId: string): Promise<UserProfile | null> {
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
            return null;
        }

        // Interactive transaction to avoid races between check and write
        const created = await db.$transaction(async (tx) => {
            const existing = await tx.userRelationship.findUnique({
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
                    return await tx.userRelationship.update({
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
                return null;
            }

            // Create new friend request
            return await tx.userRelationship.create({
                data: {
                    fromUserId,
                    toUserId,
                    status: RelationshipStatus.pending
                }
            });
        });
        if (!created) return null;
        const account = await db.account.findUnique({ where: { id: toUserId }, include: { githubUser: true } });
        if (!account) return null;
        const status = await this.getStatusBetween(fromUserId, toUserId);
        return this.buildUserProfile(account, status);
    }

    /**
     * Accept a friend request
     */
    static async acceptFriendRequest(fromUserId: string, toUserId: string): Promise<UserProfile | null> {
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
            return null;
        }

        // Use transaction to ensure both operations succeed
        const ok = await db.$transaction(async (tx) => {
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

            return !!relationship && !!reverseRelationship;
        });
        if (!ok) return null;
        const account = await db.account.findUnique({ where: { id: fromUserId }, include: { githubUser: true } });
        if (!account) return null;
        const status = await this.getStatusBetween(toUserId, fromUserId);
        return this.buildUserProfile(account, status);
    }

    /**
     * Reject a friend request
     */
    static async rejectFriendRequest(fromUserId: string, toUserId: string): Promise<UserProfile | null> {
        return await db.$transaction(async (tx) => {
            const request = await tx.userRelationship.findUnique({
                where: {
                    fromUserId_toUserId: {
                        fromUserId,
                        toUserId
                    }
                }
            });

            if (!request || request.status !== RelationshipStatus.pending) {
                return null;
            }

            const _ = await tx.userRelationship.update({
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
            const account = await tx.account.findUnique({ where: { id: fromUserId }, include: { githubUser: true } });
            if (!account) return null;
            const status = await this.getStatusBetween(toUserId, fromUserId, tx);
            return this.buildUserProfile(account, status);
        });
    }

    /**
     * Remove a friendship (both directions)
     */
    static async removeFriend(userId: string, friendId: string): Promise<UserProfile | null> {
        const ok = await db.$transaction(async (tx) => {
            await tx.userRelationship.deleteMany({
                where: {
                    OR: [
                        { fromUserId: userId, toUserId: friendId },
                        { fromUserId: friendId, toUserId: userId }
                    ]
                }
            });
            return true;
        });

        if (!ok) return null;
        const account = await db.account.findUnique({ where: { id: friendId }, include: { githubUser: true } });
        if (!account) return null;
        return this.buildUserProfile(account, RelationshipStatus.removed);
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
            fromUser: this.buildUserProfile(request.fromUser, RelationshipStatus.pending)
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

        return friends.map(friend => this.buildUserProfile(friend, RelationshipStatus.accepted));
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
