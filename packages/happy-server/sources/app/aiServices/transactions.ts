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

/** Lock a grant's shared budget and reclaim expired history across all its bindings.
 * The retention grace outlives every live reader. SQL aggregates deleted bytes in the
 * database instead of loading ciphertext into the process; no other grant is touched.
 * Call before taking turn-row locks, matching admission and publication lock order.
 */
export async function lockServiceQuota(tx: Prisma.TransactionClient, grantId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "AppDelegation" WHERE "id" = ${grantId} FOR UPDATE`;
    const cutoff = new Date(Date.now() - 60000);
    await tx.$executeRaw`WITH expired AS (
        DELETE FROM "AIServiceHistoryRequest" AS request
        USING "AIServiceBinding" AS binding
        WHERE request."bindingId" = binding."id"
            AND binding."authorizationId" = ${grantId}
            AND request."deadline" < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
        RETURNING octet_length(request."ciphertext") AS bytes
    ), released AS (
        SELECT COALESCE(SUM(bytes), 0)::integer AS bytes FROM expired
    )
    UPDATE "AppDelegation" AS storage SET "storedBytes" = storage."storedBytes" - released.bytes
    FROM released WHERE storage."id" = ${grantId} AND released.bytes > 0`;
}
