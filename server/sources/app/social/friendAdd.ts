import { Context } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { inTx } from "@/storage/inTx";
import { relationshipSet } from "./relationshipSet";
import { relationshipGet } from "./relationshipGet";
import { sendFriendRequestNotification, sendFriendshipEstablishedNotification } from "./friendNotification";
import { RelationshipStatus } from "@/storage/prisma";

/**
 * Add a friend or accept a friend request.
 * Handles:
 * - Accepting incoming friend requests (both users become friends)
 * - Sending new friend requests
 * - Sending appropriate notifications with 24-hour cooldown
 */
export async function friendAdd(ctx: Context, uid: string): Promise<UserProfile | null> {
    // Prevent self-friendship
    if (ctx.uid === uid) {
        return null;
    }

    // Update relationship status
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

        // Handle cases

        // Case 1: There's a pending request from the target user - accept it
        if (targetUserRelationship === RelationshipStatus.requested) {

            // Accept the friend request - update both to friends
            await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.friend);
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.friend);

            // Send friendship established notifications to both users
            await sendFriendshipEstablishedNotification(tx, currentUser.id, targetUser.id);

            // Return the target user profile
            return buildUserProfile(targetUser, RelationshipStatus.friend);
        }

        // Case 2: If status is none or rejected, create a new request (since other side is not in requested state)
        if (currentUserRelationship === RelationshipStatus.none
            || currentUserRelationship === RelationshipStatus.rejected) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.requested);

            // If other side is in none state, set it to pending, ignore for other states
            if (targetUserRelationship === RelationshipStatus.none) {
                await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.pending);
            }

            // Send friend request notification to the receiver
            await sendFriendRequestNotification(tx, targetUser.id, currentUser.id);

            // Return the target user profile
            return buildUserProfile(targetUser, RelationshipStatus.requested);
        }

        // Do not change anything and return the target user profile
        return buildUserProfile(targetUser, currentUserRelationship);
    });
}
