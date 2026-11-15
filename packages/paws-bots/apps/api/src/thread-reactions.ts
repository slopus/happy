import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor, MessageBlock, MessageReaction } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, messageReaction, QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  answerWaitingRunWithTextInTransaction,
  appendEventInTransaction,
  createThreadMessageInTransaction,
  IsolationError,
  loadMessageAuthor,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";
import {
  cancelSupersededQueuedRuns,
  enqueueRunsNeedingContinue,
  lockAndLoadGroupMembers,
  sendRunClientNonce,
} from "./thread-target.js";

const REACTION_TURN_COOLDOWN_MS = 30_000;

/**
 * Append a human emoji reply with its target. Any reaction to the bot's latest
 * message may wake it, with silence allowed. Only thumbs answer an ordinary pending
 * ask; busy bots, recent reaction turns, and older targets stay quiet context.
 * A 👍 on a pending takeover counts as done and hands computer control back.
 * Approval and secret asks remain on their cards. Reactions are append-only.
 */
export async function reactToThreadMessage(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  actor: Actor,
  target: ThreadTarget,
  input: {
    messageId: string;
    reaction: MessageReaction;
    clientNonce: string;
    /** False when a send to the reacted-to bot could not start a run either (no model, teaching). */
    mayStartTurn: boolean;
  },
  releaseTakeover?: (runId: string) => Promise<void>,
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Group before thread, the order every group writer uses.
    const members =
      target.kind === "group" ? await lockAndLoadGroupMembers(tx, actor, target) : undefined;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const parent = await tx.message.findFirst({
      where: { id: input.messageId, threadId: target.threadId },
      select: { id: true, seq: true, role: true, botId: true, runId: true },
    });
    if (!parent) throw new IsolationError();
    const existing = await tx.message.findUnique({
      where: {
        threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
      },
      select: { id: true },
    });
    if (existing) {
      // A retry finishes a takeover handoff whose release failed after the 👍 was saved.
      const steering = releaseTakeover
        ? await tx.steeringMessage.findFirst({
            where: { messageId: existing.id, claimedAt: null },
            select: { run: { select: { id: true, taskId: true, status: true } } },
          })
        : null;
      const run = steering?.run;
      return { eventSeq: null, runs: run?.status === "waiting_takeover" ? [run] : [] };
    }
    const currentTarget = members
      ? { ...target, memberBotIds: members.map((member) => member.botId) }
      : target;
    const replyBotId = input.mayStartTurn
      ? await reactionReplyBotId(tx, currentTarget, parent)
      : undefined;
    const botId =
      replyBotId ??
      (currentTarget.kind === "bot" ? currentTarget.botId : currentTarget.memberBotIds[0]);
    if (!botId) throw new IsolationError();
    const blocks: MessageBlock[] = [{ kind: "text", text: input.reaction }];
    const author = await loadMessageAuthor(tx, actor.userId);
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "user",
      authorUserId: actor.userId,
      blocks,
      replyToMessageId: parent.id,
      clientNonce: input.clientNonce,
    });
    const runs = replyBotId
      ? await startReactionTurn(tx, actor, target.threadId, replyBotId, parent, message, {
          ...input,
          canReleaseTakeover: Boolean(releaseTakeover),
        })
      : [];
    if (target.kind === "group") await touchGroupUpdatedAt(tx, target.groupId);
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId,
      type: "thread.message.created",
      ...(runs[0] ? { runId: runs[0].id } : {}),
      payload: {
        messageId: message.id,
        role: "user",
        blocks,
        author,
        replyToMessageId: parent.id,
        ...(runs.length ? { runIds: runs.map((run) => run.id) } : {}),
      },
    });
    return { eventSeq: event.seq, runs };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (releaseTakeover) {
    for (const run of committed.runs) {
      if (run.status === "waiting_takeover") await releaseTakeover(run.id);
    }
  }
  await enqueueRunsNeedingContinue(deps.jobs, committed.runs);
  return { eventSeq: committed.eventSeq, runIds: committed.runs.map((run) => run.id) };
}

/** The bot that wrote the thread's newest message, when the reaction targets that message. */
async function reactionReplyBotId(
  tx: Prisma.TransactionClient,
  target: ThreadTarget,
  parent: { seq: number; role: string; botId: string | null },
) {
  // Only the authenticated human reaction route calls this path; bots cannot wake each other.
  if (parent.role !== "bot" || !parent.botId) return undefined;
  const memberBotIds = target.kind === "bot" ? [target.botId] : target.memberBotIds;
  if (!memberBotIds.includes(parent.botId)) return undefined;
  // Earlier reactions may follow it; any other message means the conversation moved on.
  const newer = await tx.message.findMany({
    where: { threadId: target.threadId, seq: { gt: parent.seq } },
    orderBy: { seq: "asc" },
    take: 51,
    select: { role: true, blocks: true, replyToMessageId: true },
  });
  if (newer.length > 50) return undefined;
  const onlyReactions = newer.every((message) =>
    messageReaction({
      ...message,
      blocks: Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [],
    }),
  );
  return onlyReactions ? parent.botId : undefined;
}

async function startReactionTurn(
  tx: Prisma.TransactionClient,
  actor: Actor,
  threadId: string,
  botId: string,
  parent: { id: string; runId: string | null },
  message: { id: string; seq: number },
  input: { reaction: MessageReaction; clientNonce: string; canReleaseTakeover: boolean },
): Promise<Array<{ id: string; taskId: string; status: string }>> {
  const activeRuns = await tx.run.findMany({
    where: { threadId, botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, taskId: true, status: true, userId: true },
  });
  const holdingRuns = activeRuns.filter((run) =>
    QUEUE_HOLDING_RUN_STATUSES.some((status) => status === run.status),
  );
  const active = activeRuns.find((run) => run.id === parent.runId) ?? holdingRuns[0];
  const others = holdingRuns.filter((run) => run.id !== active?.id);
  if (active) {
    // A 👍 while this run waits for the user to finish on the computer means "done", the
    // same as a typed reply: it steers the run and the caller hands control back.
    // Only when the caller can hand control back (bot threads), as with a typed reply.
    if (
      input.canReleaseTakeover &&
      input.reaction === "👍" &&
      !others.length &&
      active.status === "waiting_takeover" &&
      active.id === parent.runId &&
      active.userId === actor.userId
    ) {
      await tx.steeringMessage.create({
        data: { messageId: message.id, botId, userId: actor.userId, runId: active.id },
      });
      await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
      return [active];
    }
    // A question waits for the person whose run asked it, as with a typed answer.
    if (
      (input.reaction === "👍" || input.reaction === "👎") &&
      active.status === "waiting_input" &&
      active.id === parent.runId &&
      active.userId === actor.userId
    ) {
      const answered = await answerWaitingRunWithTextInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId,
        runId: active.id,
        answeredByUserId: actor.userId,
        answer: input.reaction === "👍" ? "yes" : "no",
        messageId: parent.id,
      });
      if (answered) {
        await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
        return [{ ...active, status: "queued" }];
      }
      // Approval and secret cards still require an explicit card answer.
      return [];
    }
    if (holdingRuns.length) return [];
  }
  // The cooldown limits new turns only, so a quick answer to a pending ask still goes through.
  const recentReaction = await tx.run.findFirst({
    where: {
      threadId,
      botId,
      trigger: "reaction",
      status: { not: "cancelled" },
      createdAt: { gte: new Date(Date.now() - REACTION_TURN_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recentReaction) return [];
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      userId: actor.userId,
      prompt: input.reaction,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "reaction",
      clientNonce: sendRunClientNonce(input.clientNonce, message.id),
      sourceMessageId: message.id,
    },
  });
  await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
  await cancelSupersededQueuedRuns(tx, { threadId, botIds: [botId], keepRunIds: [run.id] });
  return [run];
}
