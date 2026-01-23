import { RelationshipStatus, type PrismaClientType, type TransactionClient, type RelationshipStatus as RelationshipStatusType } from "@/storage/prisma";

export async function relationshipGet(tx: TransactionClient | PrismaClientType, from: string, to: string): Promise<RelationshipStatusType> {
    const relationship = await tx.userRelationship.findFirst({
        where: {
            fromUserId: from,
            toUserId: to
        }
    });
    return relationship?.status || RelationshipStatus.none;
}
