import { Context } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";
import { relationshipSet } from "./relationshipSet";
import { relationshipGet } from "./relationshipGet";

export async function friendAdd(ctx: Context, uid: string): Promise<UserProfile | null> {
    // Prevent self-friendship
    if (ctx.uid === uid) {
        return null;
    }

    // Update relationship status
    return await db.$transaction(async (tx) => {

        // Read current user objects
        const currentUser = await tx.account.findUnique({
            where: { id: ctx.uid },
            include: { githubUser: true }
        });
        const targetUser = await tx.account.findUnique({
            where: { id: uid },
            include: { githubUser: true }
        });
        if (!currentUser || !currentUser.githubUser || !targetUser || !targetUser.githubUser) {
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

            // Return the target user profile
            return buildUserProfile(targetUser, RelationshipStatus.requested);
        }

        // Do not change anything and return the target user profile
        return buildUserProfile(targetUser, currentUserRelationship);
    });
}