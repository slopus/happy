import { Context } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";

export async function friendList(ctx: Context): Promise<UserProfile[]> {
    // Query all relationships where current user is fromUserId with friend, pending, or requested status
    const relationships = await db.userRelationship.findMany({
        where: {
            fromUserId: ctx.uid,
            status: {
                in: [RelationshipStatus.friend, RelationshipStatus.pending, RelationshipStatus.requested]
            }
        },
        include: {
            toUser: {
                include: {
                    githubUser: true
                }
            }
        }
    });

    // Filter out users without GitHub profiles and build UserProfile objects
    const profiles: UserProfile[] = [];
    for (const relationship of relationships) {
        if (relationship.toUser.githubUser) {
            profiles.push(buildUserProfile(relationship.toUser, relationship.status));
        }
    }

    return profiles;
}