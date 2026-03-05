import { Prisma, RelationshipStatus } from "@prisma/client";
import { feedPost } from "@/app/feed/feedPost";
import { Context } from "@/context";

/**
 * Check if a notification should be sent based on the last notification time and relationship status.
 * Returns true if:
 * - No previous notification was sent (lastNotifiedAt is null)
 * - OR 24 hours have passed since the last notification
 * - AND the relationship is not rejected
 */
export function shouldSendNotification(
    lastNotifiedAt: Date | null,
    status: RelationshipStatus
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
 * Creates a feed item for the receiver about the incoming friend request.
 * Uses repeatKey `friend_${senderUserId}` so that a subsequent friend_accepted
 * notification replaces this item in the feed.
 */
export async function sendFriendRequestNotification(
    tx: Prisma.TransactionClient,
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
        `friend_${senderUserId}` // shared with friend_accepted so acceptance replaces request
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
 * Creates feed items for both users about the new friendship.
 * Uses repeatKey `friend_${otherUserId}` to replace any existing friend_request item.
 * Always sends (no 24h cooldown) — accepting is a state transition, not a repeated notification.
 */
export async function sendFriendshipEstablishedNotification(
    tx: Prisma.TransactionClient,
    user1Id: string,
    user2Id: string
): Promise<void> {
    // Always send friend_accepted to user1 (no cooldown — acceptance is a state change)
    const user1Ctx = Context.create(user1Id);
    await feedPost(
        tx,
        user1Ctx,
        {
            kind: 'friend_accepted',
            uid: user2Id
        },
        `friend_${user2Id}` // replaces any existing friend_request from user2
    );

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

    // Always send friend_accepted to user2 (no cooldown — acceptance is a state change)
    const user2Ctx = Context.create(user2Id);
    await feedPost(
        tx,
        user2Ctx,
        {
            kind: 'friend_accepted',
            uid: user1Id
        },
        `friend_${user1Id}` // replaces any existing friend_request from user1
    );

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
