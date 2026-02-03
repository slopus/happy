import { Prisma, PrismaClient } from "@prisma/client";
import { RelationshipStatus } from "@prisma/client";

export async function relationshipGet(tx: Prisma.TransactionClient | PrismaClient, from: string, to: string): Promise<RelationshipStatus> {
    const relationship = await tx.userRelationship.findFirst({
        where: {
            fromUserId: from,
            toUserId: to
        }
    });
    return relationship?.status || RelationshipStatus.none;
}