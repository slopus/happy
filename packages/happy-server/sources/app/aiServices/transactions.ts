import type { Prisma, PrismaClient } from '@prisma/client';

/** Take this before service, authorization, worker, turn or identity locks.
 * Native credential mutations lock Account FOR UPDATE before changing profiles.
 * KEY SHARE prevents that inversion and covers Account foreign-key inserts, while
 * allowing shared-service transactions (including cancellation) to run concurrently.
 */
export async function lockServiceAccount(tx: Prisma.TransactionClient, ownerId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${ownerId} FOR KEY SHARE`;
}

export function serviceTransaction<T>(database: PrismaClient, ownerId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return database.$transaction(async tx => {
        await lockServiceAccount(tx, ownerId);
        return operation(tx);
    });
}
