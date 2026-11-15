import type { Prisma, PrismaClient } from "./client.js";
import { runAsSystem, runAsSystemInTransaction } from "./row-security.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

/**
 * Each member of a Space has their own state for each chat there (`thread_reads`): how far they
 * have read, and any snooze. A chat with no row for someone is caught up and not snoozed.
 */

type Reader = { threadId: string; spaceId: string; userId: string };

/** Selects one person's read state on a thread, for `unreadFor` and `snoozedUntilFor`. */
export function readStateFor(userId: string) {
  return { where: { userId }, select: { unread: true, snoozedUntil: true } } as const;
}

export function unreadFor(thread: { reads: Array<{ unread: boolean }> }): boolean {
  return thread.reads[0]?.unread ?? false;
}

export function snoozedUntilFor(thread: {
  reads: Array<{ snoozedUntil: Date | null }>;
}): string | null {
  return thread.reads[0]?.snoozedUntil?.toISOString() ?? null;
}

/**
 * Marks a chat unread for every member of its Space except whoever wrote the message at `seq`.
 * Someone with no read state yet had read everything before it.
 */
export async function markThreadUnreadForMembers(
  tx: Prisma.TransactionClient,
  input: { threadId: string; spaceId: string; seq: number; exceptUserId?: string },
): Promise<void> {
  await runAsSystemInTransaction(
    tx,
    "mark a chat unread for the members of its Space",
    () =>
      tx.$executeRaw`
      INSERT INTO thread_reads ("threadId", "userId", "spaceId", unread, "lastReadSeq")
      SELECT ${input.threadId}, m."userId", m."spaceId", true, ${input.seq - 1}::int
      FROM space_members m
      WHERE m."spaceId" = ${input.spaceId} AND m."userId" <> ${input.exceptUserId ?? ""}
      ON CONFLICT ("threadId", "userId") DO UPDATE SET unread = true`,
  );
}

/** A cleared chat has nothing left to read, for anyone. Snoozes stay. */
export async function clearThreadReads(tx: Prisma.TransactionClient, threadId: string) {
  await runAsSystemInTransaction(
    tx,
    "clear every member's read state for a cleared chat",
    async () => {
      await tx.threadRead.deleteMany({ where: { threadId, snoozedUntil: null } });
      await tx.threadRead.updateMany({ where: { threadId }, data: { unread: false } });
    },
  );
}

/**
 * Marks the chat read up to its latest message for one person. Returns the seq they had read up
 * to before, or null when the chat wasn't unread for them or nothing new arrived; the first
 * answer of a visit places the "New" divider. The thread row is held so a message cannot land
 * between reading the latest seq and writing it.
 */
export function markThreadReadFor(prisma: PrismaClient, reader: Reader): Promise<number | null> {
  const { threadId, userId } = reader;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await lockThread(tx, reader);
      if (!thread) return null;
      const latestSeq = thread.nextMessageSeq - 1;
      // Held until commit, so a Mark as Unread from another tab lands before or after, not lost.
      const [read] = await tx.$queryRaw<
        Array<{ unread: boolean; lastReadSeq: number; woke: boolean }>
      >`
        SELECT unread, "lastReadSeq", "snoozedUntil" <= now() AS woke FROM thread_reads
        WHERE "threadId" = ${threadId} AND "userId" = ${userId}
        FOR UPDATE`;
      if (!read || (!read.unread && !read.woke && read.lastReadSeq >= latestSeq)) return null;
      await tx.threadRead.update({
        where: { threadId_userId: { threadId, userId } },
        // Opening a chat that woke from a snooze ends the snooze.
        data: {
          unread: false,
          lastReadSeq: latestSeq,
          ...(read.woke ? { snoozedUntil: null } : {}),
        },
      });
      // A chat only gets a divider when its unread dot was on, so replies seen live never do.
      return read.unread && read.lastReadSeq < latestSeq ? read.lastReadSeq : null;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Holds the thread as markThreadReadFor does: a clear waits, and its seq is the latest. */
async function lockThread(tx: Prisma.TransactionClient, reader: Reader) {
  const [thread] = await tx.$queryRaw<Array<{ nextMessageSeq: number }>>`
    SELECT "nextMessageSeq" FROM threads
    WHERE id = ${reader.threadId} AND "spaceId" = ${reader.spaceId}
    FOR SHARE`;
  return thread;
}

/**
 * Marks the chat unread for one person from one of its messages: the divider goes above it.
 * False when the message is gone, such as after the chat was cleared.
 */
export function markThreadUnreadFromFor(
  prisma: PrismaClient,
  reader: Reader,
  messageId: string,
): Promise<boolean> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      if (!(await lockThread(tx, reader))) return false;
      const message = await tx.message.findFirst({
        where: { id: messageId, threadId: reader.threadId },
        select: { seq: true },
      });
      if (!message) return false;
      const state = { unread: true, lastReadSeq: message.seq - 1 };
      await tx.threadRead.upsert({
        where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
        create: { ...reader, ...state },
        update: state,
      });
      return true;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Mark as Read or Unread from the chat list, without moving where the divider goes. */
export async function setThreadUnreadFor(prisma: PrismaClient, reader: Reader, unread: boolean) {
  if (!unread) {
    await prisma.threadRead.updateMany({
      where: { threadId: reader.threadId, userId: reader.userId, unread: true },
      data: { unread: false },
    });
    return;
  }
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await lockThread(tx, reader);
      if (!thread) return;
      await tx.threadRead.upsert({
        where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
        // Someone with no read state had read it all.
        create: { ...reader, unread: true, lastReadSeq: thread.nextMessageSeq - 1 },
        update: { unread: true },
      });
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Snoozes the chat for one person until `until`, or wakes it with null. */
export async function setThreadSnoozeFor(prisma: PrismaClient, reader: Reader, until: Date | null) {
  if (!until) {
    await prisma.threadRead.updateMany({
      where: { threadId: reader.threadId, userId: reader.userId },
      data: { snoozedUntil: null },
    });
    return;
  }
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const thread = await lockThread(tx, reader);
      if (!thread) return;
      await tx.threadRead.upsert({
        where: { threadId_userId: { threadId: reader.threadId, userId: reader.userId } },
        // Someone with no read state had read it all.
        create: { ...reader, lastReadSeq: thread.nextMessageSeq - 1, snoozedUntil: until },
        update: { snoozedUntil: until },
      });
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
}

/** Who among `userIds` has the chat snoozed right now, so its news can wait for them. */
export async function membersSnoozing(
  prisma: PrismaClient,
  threadId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await runAsSystem("find which members have a chat snoozed", () =>
    prisma.threadRead.findMany({
      where: { threadId, userId: { in: [...userIds] }, snoozedUntil: { gt: new Date() } },
      select: { userId: true },
    }),
  );
  return new Set(rows.map((row) => row.userId));
}
