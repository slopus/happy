import { Context } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { afterTx, inTx } from "@/storage/inTx";
import { RelationshipStatus } from "@prisma/client";
import { relationshipSet } from "./relationshipSet";
import { relationshipGet } from "./relationshipGet";
import { allocateUserSeq } from "@/storage/seq";
import { eventRouter, buildRelationshipUpdatedEvent } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

/**
 * Remove a friend, reject a friend request, or cancel an outgoing request.
 * Handles:
 * - Cancelling own request (requested → rejected): clears other side's pending, deletes feed item
 * - Removing friend (friend → pending/requested): reverts to request state
 * - Rejecting incoming request (pending → none): clears both sides, deletes feed item
 */
export async function friendRemove(ctx: Context, uid: string): Promise<UserProfile | null> {
    return await inTx(async (tx) => {

        // Read current user objects
        const currentUser = await tx.account.findUnique({
            where: { id: ctx.uid },
            include: { githubUser: true }
        });
        const targetUser = await tx.account.findUnique({
            where: { id: uid },
            include: { githubUser: true }
        });
        if (!currentUser || !targetUser) {
            return null;
        }

        // Read relationship status
        const currentUserRelationship = await relationshipGet(tx, currentUser.id, targetUser.id);
        const targetUserRelationship = await relationshipGet(tx, targetUser.id, currentUser.id);

        const currentId = currentUser.id;
        const targetId = targetUser.id;

        // If status is requested, set it to rejected (cancel own request)
        // Also clear the other side's pending status so they don't see a stale request
        if (currentUserRelationship === RelationshipStatus.requested) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.rejected);
            if (targetUserRelationship === RelationshipStatus.pending) {
                await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.none);

                // Delete the friend_request feed item from the target's feed
                await tx.userFeedItem.deleteMany({
                    where: {
                        userId: targetId,
                        repeatKey: `friend_${currentId}`
                    }
                });
            }
            afterTx(tx, async () => {
                if (targetUserRelationship === RelationshipStatus.pending) {
                    const seq = await allocateUserSeq(targetId);
                    eventRouter.emitUpdate({
                        userId: targetId,
                        payload: buildRelationshipUpdatedEvent({ uid: currentId, status: 'none', timestamp: Date.now() }, seq, randomKeyNaked(12))
                    });
                }
            });

            return buildUserProfile(targetUser, RelationshipStatus.rejected);
        }

        // If they are friends, change it to pending and requested (remove friend)
        if (currentUserRelationship === RelationshipStatus.friend) {
            await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.requested);
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.pending);

            // Only notify the other user — caller already has the API response
            afterTx(tx, async () => {
                const seq = await allocateUserSeq(targetId);
                eventRouter.emitUpdate({
                    userId: targetId,
                    payload: buildRelationshipUpdatedEvent({ uid: currentId, status: 'requested', timestamp: Date.now() }, seq, randomKeyNaked(12))
                });
            });

            return buildUserProfile(targetUser, RelationshipStatus.requested);
        }

        // If status is pending, set it to none (reject incoming request)
        if (currentUserRelationship === RelationshipStatus.pending) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.none);
            const targetAlsoCleared = targetUserRelationship !== RelationshipStatus.rejected;
            if (targetAlsoCleared) {
                await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.none);
            }

            // Delete the friend_request feed item from the current user's feed
            await tx.userFeedItem.deleteMany({
                where: {
                    userId: currentId,
                    repeatKey: `friend_${targetId}`
                }
            });

            // Only notify the other user — caller already has the API response
            afterTx(tx, async () => {
                if (targetAlsoCleared) {
                    const seq = await allocateUserSeq(targetId);
                    eventRouter.emitUpdate({
                        userId: targetId,
                        payload: buildRelationshipUpdatedEvent({ uid: currentId, status: 'none', timestamp: Date.now() }, seq, randomKeyNaked(12))
                    });
                }
            });

            return buildUserProfile(targetUser, RelationshipStatus.none);
        }

        // Return the target user profile with status none
        return buildUserProfile(targetUser, currentUserRelationship);
    });
}
