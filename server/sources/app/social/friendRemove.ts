import { Context } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { inTx } from "@/storage/inTx";
import { relationshipSet } from "./relationshipSet";
import { relationshipGet } from "./relationshipGet";
import { RelationshipStatus } from "@/storage/prisma";

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

        // If status is requested, set it to rejected
        if (currentUserRelationship === RelationshipStatus.requested) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.rejected);
            return buildUserProfile(targetUser, RelationshipStatus.rejected);
        }

        // If they are friends, change it to pending and requested
        if (currentUserRelationship === RelationshipStatus.friend) {
            await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.requested);
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.pending);
            return buildUserProfile(targetUser, RelationshipStatus.requested);
        }

        // If status is pending, set it to none
        if (currentUserRelationship === RelationshipStatus.pending) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.none);
            if (targetUserRelationship !== RelationshipStatus.rejected) {
                await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.none);
            }
            return buildUserProfile(targetUser, RelationshipStatus.none);
        }

        // Return the target user profile with status none
        return buildUserProfile(targetUser, currentUserRelationship);
    });
}
