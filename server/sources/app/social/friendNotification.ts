import { RelationshipStatus, type RelationshipStatus as RelationshipStatusType, type TransactionClient } from "@/storage/prisma";
import { feedPost } from "@/app/feed/feedPost";
import { Context } from "@/context";
import { afterTx } from "@/storage/inTx";

/**
 * Check if a notification should be sent based on the last notification time and relationship status.
 * Returns true if:
 * - No previous notification was sent (lastNotifiedAt is null)
 * - OR 24 hours have passed since the last notification
 * - AND the relationship is not rejected
 */
export function shouldSendNotification(
    lastNotifiedAt: Date | null,
    status: RelationshipStatusType
): boolean {
    // Don't send notifications for rejected relationships
    if (status === RelationshipStatus.rejected) {
        return false;
    }

    // If never notified, send notification
    if (!lastNotifiedAt) {
        return true;
    }

    // Check if 24 hours have passed since last notification
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return lastNotifiedAt < twentyFourHoursAgo;
}

/**
 * Send a friend request notification to the receiver and update lastNotifiedAt.
 * This creates a feed item for the receiver about the incoming friend request.
 */
export async function sendFriendRequestNotification(
    tx: TransactionClient,
    receiverUserId: string,
    senderUserId: string
): Promise<void> {
    // Check if we should send notification to receiver
    const receiverRelationship = await tx.userRelationship.findUnique({
        where: {
            fromUserId_toUserId: {
                fromUserId: receiverUserId,
                toUserId: senderUserId
            }
        }
    });

    if (!receiverRelationship || !shouldSendNotification(
        receiverRelationship.lastNotifiedAt,
        receiverRelationship.status
    )) {
        return;
    }

    // Create feed notification for receiver
    const receiverCtx = Context.create(receiverUserId);
    await feedPost(
        tx,
        receiverCtx,
        {
            kind: 'friend_request',
            uid: senderUserId
        },
        `friend_request_${senderUserId}` // repeatKey to avoid duplicates
    );

    // Update lastNotifiedAt for the receiver's relationship record
    await tx.userRelationship.update({
        where: {
            fromUserId_toUserId: {
                fromUserId: receiverUserId,
                toUserId: senderUserId
            }
        },
        data: {
            lastNotifiedAt: new Date()
        }
    });
}

/**
 * Send friendship established notifications to both users and update lastNotifiedAt.
 * This creates feed items for both users about the new friendship.
 */
export async function sendFriendshipEstablishedNotification(
    tx: TransactionClient,
    user1Id: string,
    user2Id: string
): Promise<void> {
    // Check and send notification to user1
    const user1Relationship = await tx.userRelationship.findUnique({
        where: {
            fromUserId_toUserId: {
                fromUserId: user1Id,
                toUserId: user2Id
            }
        }
    });

    if (user1Relationship && shouldSendNotification(
        user1Relationship.lastNotifiedAt,
        user1Relationship.status
    )) {
        const user1Ctx = Context.create(user1Id);
        await feedPost(
            tx,
            user1Ctx,
            {
                kind: 'friend_accepted',
                uid: user2Id
            },
            `friend_accepted_${user2Id}` // repeatKey to avoid duplicates
        );

        // Update lastNotifiedAt for user1
        await tx.userRelationship.update({
            where: {
                fromUserId_toUserId: {
                    fromUserId: user1Id,
                    toUserId: user2Id
                }
            },
            data: {
                lastNotifiedAt: new Date()
            }
        });
    }

    // Check and send notification to user2
    const user2Relationship = await tx.userRelationship.findUnique({
        where: {
            fromUserId_toUserId: {
                fromUserId: user2Id,
                toUserId: user1Id
            }
        }
    });

    if (user2Relationship && shouldSendNotification(
        user2Relationship.lastNotifiedAt,
        user2Relationship.status
    )) {
        const user2Ctx = Context.create(user2Id);
        await feedPost(
            tx,
            user2Ctx,
            {
                kind: 'friend_accepted',
                uid: user1Id
            },
            `friend_accepted_${user1Id}` // repeatKey to avoid duplicates
        );

        // Update lastNotifiedAt for user2
        await tx.userRelationship.update({
            where: {
                fromUserId_toUserId: {
                    fromUserId: user2Id,
                    toUserId: user1Id
                }
            },
            data: {
                lastNotifiedAt: new Date()
            }
        });
    }
}
