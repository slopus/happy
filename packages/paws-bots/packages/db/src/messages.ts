import type { MessageAuthor, MessageBlock, ToolHistory } from "@rakazo/contracts";
import { splitToolHistory } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { markThreadUnreadForMembers } from "./thread-reads.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

/**
 * Group turns use channel inputs and their own outputs, never private thread history.
 * `steeringMessages` is non-empty for a message still waiting for its own run, which the caller
 * leaves out of this run's history.
 */
export async function loadRunHistoryMessages(
  prisma: PrismaClient,
  run: { id: string; threadId: string; botId: string; userId: string },
  limit: number,
  channelId?: string,
) {
  const messages = await prisma.message.findMany({
    where: {
      threadId: run.threadId,
      ...(channelId
        ? {
            OR: [
              {
                role: "user",
                blocks: { array_contains: [{ kind: "channel_message", channelId }] },
              },
              { role: "bot", runId: run.id },
            ],
          }
        : {}),
    },
    orderBy: { seq: "desc" },
    take: limit,
    select: {
      id: true,
      threadId: true,
      seq: true,
      role: true,
      botId: true,
      runId: true,
      blocks: true,
      // Only the bot's own runs read this: it is what its earlier tool calls were sent and returned.
      toolHistory: true,
      authorUserId: true,
      createdAt: true,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: { id: true, threadId: true, role: true, botId: true, blocks: true } },
      clientNonce: true,
      steeringMessages: { where: { botId: run.botId, runId: null }, select: { id: true } },
    },
  });
  return withOwnToolHistory(prisma, run, messages);
}

/**
 * Keeps a reply's tool history only for runs of the same bot started by the same person: in a
 * shared space another member's run of the bot sees the reply as everyone does, never what its
 * tools read (an owner's inbox, say).
 */
async function withOwnToolHistory<
  M extends { runId: string | null; botId: string | null; toolHistory: string | null },
>(prisma: PrismaClient, run: { botId: string; userId: string }, messages: M[]): Promise<M[]> {
  const runIds = [...new Set(messages.flatMap((m) => (m.toolHistory && m.runId ? [m.runId] : [])))];
  if (!runIds.length) return messages;
  const owners = new Map(
    (
      await prisma.run.findMany({
        where: { id: { in: runIds } },
        select: { id: true, userId: true },
      })
    ).map((row) => [row.id, row.userId]),
  );
  return messages.map((m) =>
    m.toolHistory && !(m.botId === run.botId && m.runId && owners.get(m.runId) === run.userId)
      ? { ...m, toolHistory: null }
      : m,
  );
}

/** Marks the bot message that keeps the reply text of a run that failed partway through it. */
export function partialReplyClientNonce(runId: string): string {
  return `partial-reply:${runId}`;
}

export function isPartialReplyClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith("partial-reply:"));
}

export interface CreateThreadMessageInput {
  threadId: string;
  role: "user" | "bot" | "system";
  blocks: MessageBlock[];
  /** A bot reply's tool calls as sent and returned, for its later runs only. */
  toolHistory?: ToolHistory;
  botId?: string;
  /** The signed-in person who wrote a user message; null when the sender is not a known user. */
  authorUserId?: string;
  replyToMessageId?: string;
  replyQuote?: string;
  runId?: string;
  clientNonce?: string;
  markUnread?: boolean;
  /** Terminal echo after the run is already cancelled. Every other write stays rejected. */
  allowCancelledRun?: boolean;
  /** The executing attempt's lease; a superseded attempt cannot write. */
  lease?: RunLease;
}

export async function createThreadMessage(prisma: PrismaClient, input: CreateThreadMessageInput) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx: Prisma.TransactionClient) => createThreadMessageInTransaction(tx, input),
      THREAD_LOCK_TRANSACTION_OPTIONS,
    ),
  );
}

export async function createThreadMessageInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateThreadMessageInput,
) {
  const thread = await tx.thread.update({
    where: { id: input.threadId },
    data: { nextMessageSeq: { increment: 1 } },
    select: { nextMessageSeq: true, spaceId: true },
  });
  await assertRunCanWriteHistory(tx, input.runId, {
    allowCancelled: input.allowCancelledRun,
    lease: input.lease,
  });
  // A bot's message is new to everyone in the Space; a person's is new to everyone else.
  if (input.markUnread ?? (input.role === "bot" || input.authorUserId !== undefined)) {
    await markThreadUnreadForMembers(tx, {
      threadId: input.threadId,
      spaceId: thread.spaceId,
      seq: thread.nextMessageSeq - 1,
      exceptUserId: input.authorUserId,
    });
  }
  // Kept calls never stay in the blocks clients read; they go in their own encrypted column.
  const split = splitToolHistory(input.blocks);
  const toolHistory = input.toolHistory ?? split.toolHistory;
  return tx.message.create({
    data: {
      threadId: input.threadId,
      seq: thread.nextMessageSeq - 1,
      role: input.role,
      blocks: split.blocks as Prisma.InputJsonValue,
      ...(toolHistory ? { toolHistory: JSON.stringify(toolHistory) } : {}),
      botId: input.botId,
      authorUserId: input.authorUserId,
      replyToMessageId: input.replyToMessageId,
      replyQuote: input.replyQuote,
      runId: input.runId,
      clientNonce: input.clientNonce,
    },
  });
}

/** One lookup for every author on a page. A deleted account has no author. */
export async function loadMessageAuthors(
  db: Pick<Prisma.TransactionClient, "user">,
  userIds: Iterable<string | null | undefined>,
): Promise<Map<string, MessageAuthor>> {
  const ids = [...new Set(userIds)].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user]));
}

export async function loadMessageAuthor(
  db: Pick<Prisma.TransactionClient, "user">,
  userId: string | null | undefined,
): Promise<MessageAuthor | undefined> {
  return userId ? (await loadMessageAuthors(db, [userId])).get(userId) : undefined;
}

export class RunHistoryWriteError extends Error {
  constructor() {
    super("Run cannot write thread history");
    this.name = "RunHistoryWriteError";
  }
}

export interface RunLease {
  owner: string;
  fence: number;
}

/**
 * Writes from a run's executing attempt pass its lease. The row stays share-locked until the
 * write commits, so no worker can reclaim the run between this check and the write. Pausing
 * or finishing releases the owner but keeps the fence, so only a newer claim supersedes it.
 */
export async function assertRunCanWriteHistory(
  tx: Prisma.TransactionClient,
  runId?: string,
  options?: { allowCancelled?: boolean; lease?: RunLease },
): Promise<
  | {
      status: string;
      startedAt: Date | null;
      firstResponseAt: Date | null;
      userId: string;
      leaseOwner: string | null;
    }
  | undefined
> {
  if (!runId) return;
  const lease = options?.lease;
  if (lease) await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR SHARE`;
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: {
      status: true,
      startedAt: true,
      firstResponseAt: true,
      userId: true,
      leaseOwner: true,
      leaseFence: true,
    },
  });
  if (!run || (run.status === "cancelled" && !options?.allowCancelled)) {
    throw new RunHistoryWriteError();
  }
  if (
    lease &&
    (run.leaseFence !== lease.fence || (run.leaseOwner !== null && run.leaseOwner !== lease.owner))
  ) {
    throw new RunHistoryWriteError();
  }
  return run;
}

/**
 * run.cancelled is recorded by the path that cancelled the run, after the row
 * already reads cancelled — where the liveness assert above would reject it.
 * The event must name its run (clients key off it) and the row must already be
 * cancelled, so it can never announce a cancellation nothing committed.
 */
export async function assertRunIsCancelled(
  tx: Prisma.TransactionClient,
  runId?: string,
): Promise<void> {
  if (!runId) throw new RunHistoryWriteError();
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (run?.status !== "cancelled") {
    throw new RunHistoryWriteError();
  }
}
