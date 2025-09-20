import { Prisma } from "@prisma/client";
import { RelationshipStatus } from "@prisma/client";

export async function relationshipSet(tx: Prisma.TransactionClient, from: string, to: string, status: RelationshipStatus) {
    if (status === RelationshipStatus.friend) {
        await tx.userRelationship.upsert({
            where: {
                fromUserId_toUserId: {
                    fromUserId: from,
                    toUserId: to
                }
            },
            create: {
                fromUserId: from,
                toUserId: to,
                status,
                acceptedAt: new Date()
            },
            update: {
                status,
                acceptedAt: new Date()
            }
        });
    } else {
        await tx.userRelationship.upsert({
            where: {
                fromUserId_toUserId: {
                    fromUserId: from,
                    toUserId: to
                }
            },
            create: {
                fromUserId: from,
                toUserId: to,
                status,
                acceptedAt: null
            },
            update: {
                status,
                acceptedAt: null
            }
        });
    }
}