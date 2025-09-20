import { Prisma } from "@prisma/client";
import { RelationshipStatus } from "@prisma/client";

export async function relationshipSet(tx: Prisma.TransactionClient, from: string, to: string, status: RelationshipStatus, lastNotifiedAt?: Date) {
    // Get existing relationship to preserve lastNotifiedAt
    const existing = await tx.userRelationship.findUnique({
        where: {
            fromUserId_toUserId: {
                fromUserId: from,
                toUserId: to
            }
        }
    });
    
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
                acceptedAt: new Date(),
                lastNotifiedAt: lastNotifiedAt || null
            },
            update: {
                status,
                acceptedAt: new Date(),
                // Preserve existing lastNotifiedAt, only update if explicitly provided
                lastNotifiedAt: lastNotifiedAt || existing?.lastNotifiedAt || undefined
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
                acceptedAt: null,
                lastNotifiedAt: lastNotifiedAt || null
            },
            update: {
                status,
                acceptedAt: null,
                // Preserve existing lastNotifiedAt, only update if explicitly provided
                lastNotifiedAt: lastNotifiedAt || existing?.lastNotifiedAt || undefined
            }
        });
    }
}