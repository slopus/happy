import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { releasedTakeoverComputerBlocks } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { notifyRealtime } from "./event-stream.js";
import { appendEventInTransaction, transientRunEventsWhere } from "./events.js";
import type { RunLease } from "./messages.js";
import { draftRecordingsOfLeaseInTransaction } from "./teaching-recordings.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

export type TakeoverAnswer = "done" | "skipped";

export interface AnswerTakeoverRequestInput {
  spaceId: string;
  botId: string;
  runId: string;
  reason: TakeoverAnswer;
}

export interface ReleaseUserControlInput {
  spaceId: string;
  computerId: string;
  /** The bot whose chat hears of it; none for a lease left without one. */
  botId: string | null;
  leaseId: string;
  reason: "released" | "expired" | "done" | "skipped";
}

export interface PauseRunForTakeover {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  reason: string;
}

export async function pauseRunForTakeover(
  prisma: PrismaClient,
  input: PauseRunForTakeover,
  realtime?: RealtimeFanout,
): Promise<boolean | { continuationRunId: string }> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // An answer and a pause both lock thread, then run.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: { checkpoint: true, userId: true },
    });
    const released = run?.checkpoint === "takeover" || run?.checkpoint === "takeover-skipped";
    const paused = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: released ? "queued" : "waiting_takeover",
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpoint: released ? run.checkpoint : null,
      },
    });
    if (paused.count !== 1) return null;

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: released ? "interrupted" : "waiting_takeover", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to pause");

    // The person can answer while the runtime is still preparing its pause. Keep the
    // answer's checkpoint and continue instead of waiting again.
    if (released) {
      const seq = await settleReleasedTakeoverCardsInTransaction(tx, {
        ...input,
        reason: run.checkpoint === "takeover-skipped" ? "skipped" : "done",
      });
      return { threadId: input.threadId, seq, continuationRunId: input.runId };
    }

    const waitingEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "computer.takeover.requested",
      runId: input.runId,
      payload: { reason: input.reason, takeoverRequested: true, retainedControl: true },
    });
    await tx.event.deleteMany({
      where: { runId: input.runId, ...transientRunEventsWhere() },
    });
    return { threadId: waitingEvent.threadId, seq: waitingEvent.seq, continuationRunId: null };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);

  if (!committed) return false;
  if (committed.seq !== null) {
    await notifyRealtime(realtime, committed.threadId, committed.seq);
  }
  return committed.continuationRunId ? { continuationRunId: committed.continuationRunId } : true;
}

/**
 * Answer a run's request for a person (Done or Skip): the waiting run continues from the
 * answer, or a run still preparing its pause picks the answer up. Returns whether it applied.
 */
export async function answerTakeoverRequest(
  prisma: PrismaClient,
  input: AnswerTakeoverRequestInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const run = await tx.run.findFirst({
      where: { id: input.runId, spaceId: input.spaceId, botId: input.botId },
      select: { threadId: true },
    });
    if (!run) return null;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    // Each request is answered once: its card is published before the run pauses and settled by
    // the answer, so a second Done or Skip finds nothing pending and never stamps a later request.
    if (!(await hasPendingTakeoverCard(tx, run.threadId, input.runId))) return null;
    const checkpoint = input.reason === "skipped" ? "takeover-skipped" : "takeover";
    const resumed = await tx.run.updateMany({
      where: { id: input.runId, status: "waiting_takeover" },
      data: { status: "queued", checkpoint },
    });
    // A run still preparing its pause holds its lease; stamping the checkpoint lets it continue.
    const stamped =
      resumed.count === 1
        ? resumed
        : await tx.run.updateMany({
            where: { id: input.runId, status: { in: ["leased", "running"] } },
            data: { checkpoint },
          });
    if (stamped.count !== 1) return null;
    await settleReleasedTakeoverCardsInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: run.threadId,
      botId: input.botId,
      runId: input.runId,
      reason: input.reason,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: run.threadId,
      botId: input.botId,
      runId: input.runId,
      type: "computer.takeover.released",
      payload: { holder: "none", leaseId: null, reason: input.reason, answered: true },
    });
    return { threadId: event.threadId, seq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  return true;
}

/**
 * Clear a person's control of a computer, if this lease still holds it, and say so in chat. A
 * teaching recording made under the lease ends with it, saved as a draft.
 */
export async function releaseUserControl(
  prisma: PrismaClient,
  input: ReleaseUserControlInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cleared = await tx.computer.updateMany({
      where: { id: input.computerId, spaceId: input.spaceId, controlLeaseId: input.leaseId },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlUserId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
      },
    });
    if (cleared.count !== 1) return null;
    const drafted = await draftRecordingsOfLeaseInTransaction(tx, input);
    const notices = drafted.flatMap((ended) =>
      "seq" in ended ? [{ threadId: ended.threadId, seq: ended.seq }] : [],
    );
    const bot = input.botId
      ? await tx.bot.findFirst({
          where: { id: input.botId, spaceId: input.spaceId },
          select: { thread: { select: { id: true } } },
        })
      : null;
    if (input.botId && bot?.thread) {
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: bot.thread.id,
        botId: input.botId,
        type: "computer.takeover.released",
        payload: { holder: "none", leaseId: input.leaseId, reason: input.reason },
      });
      notices.push({ threadId: event.threadId, seq: event.seq });
    }
    return { notices };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!committed) return false;
  for (const notice of committed.notices) {
    await notifyRealtime(realtime, notice.threadId, notice.seq);
  }
  return true;
}

/**
 * Clear a pending takeover computer card when the run resumes.
 * Release already settles the card; this covers a card that is still pending.
 * No message write and no notify when nothing is pending.
 */
export async function settleReleasedTakeoverCards(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    reason: unknown;
    lease?: RunLease;
  },
  notify?: (threadId: string, seq: number) => Promise<void>,
): Promise<void> {
  const seq = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    return settleReleasedTakeoverCardsInTransaction(tx, input);
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (seq !== null) await notify?.(input.threadId, seq);
}

async function hasPendingTakeoverCard(
  tx: Prisma.TransactionClient,
  threadId: string,
  runId: string,
): Promise<boolean> {
  const messages = await tx.message.findMany({
    where: { threadId, runId, role: "bot" },
    select: { blocks: true },
  });
  return messages.some((message) => {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    return parsed.success && releasedTakeoverComputerBlocks(parsed.data, "done") !== null;
  });
}

async function settleReleasedTakeoverCardsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    reason: unknown;
    lease?: RunLease;
  },
): Promise<number | null> {
  const messages = await tx.message.findMany({
    where: { threadId: input.threadId, runId: input.runId, role: "bot" },
    select: { id: true, blocks: true },
  });
  let lastSeq: number | null = null;
  for (const message of messages) {
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const blocks = releasedTakeoverComputerBlocks(parsed.data, input.reason);
    if (!blocks) continue;
    await tx.message.update({
      where: { id: message.id },
      data: { blocks: blocks as Prisma.InputJsonValue },
    });
    const updated = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.updated",
      runId: input.runId,
      lease: input.lease,
      payload: { messageId: message.id, role: "bot", blocks },
    });
    lastSeq = updated.seq;
  }
  return lastSeq;
}
