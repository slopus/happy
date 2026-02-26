import { db } from "@/storage/db";
import type { Prisma } from "@prisma/client";

type SeqClient = Pick<Prisma.TransactionClient, "account" | "session">;

function resolveClient(tx?: SeqClient) {
    return tx ?? db;
}

export async function allocateUserSeq(accountId: string) {
    const user = await db.account.update({
        where: { id: accountId },
        select: { seq: true },
        data: { seq: { increment: 1 } }
    });
    const seq = user.seq;
    return seq;
}

export async function allocateSessionSeq(sessionId: string) {
    const session = await db.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: 1 } }
    });
    const seq = session.seq;
    return seq;
}

/**
 * Allocates N consecutive sequence numbers for a session in a single atomic
 * database operation. Uses `increment: count` so the DB returns the final seq,
 * then derives the full range [endSeq - count + 1 .. endSeq].
 *
 * @param sessionId - The session to allocate sequences for
 * @param count     - How many consecutive sequence numbers to allocate
 * @param tx        - Optional transaction client; falls back to the default db
 * @returns Array of `count` consecutive sequence numbers, or [] if count <= 0
 */
export async function allocateSessionSeqBatch(sessionId: string, count: number, tx?: SeqClient) {
    if (count <= 0) {
        return [] as number[];
    }

    const client = resolveClient(tx);
    const session = await client.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: count } }
    });

    const endSeq = session.seq;
    const startSeq = endSeq - count + 1;
    return Array.from({ length: count }, (_, index) => startSeq + index);
}