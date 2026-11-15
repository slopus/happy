import type { MessageBlock } from "@rakazo/contracts";
import {
  blocksToAgentHistoryText,
  isConversationalRun,
  messagingChannelId,
  QUEUE_HOLDING_RUN_STATUSES,
  STEERING_CONTINUATION_PROMPT,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

export interface ClaimSteeringInput {
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  seenIds: string[];
}

export interface ClaimedSteeringMessage {
  id: string;
  messageId: string;
  text: string;
  blocks: MessageBlock[];
  /**
   * Who sent it: the run's own person (in the app or a connected chat), another member of the
   * chat, someone else in a connected chat, or a webhook.
   */
  origin: "user" | "member" | "messaging" | "webhook";
}

export async function claimSteering(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  // Runs claim before every model turn, so a briefly saturated pool must not fail the run.
  return withTransactionRetry(() => claimSteeringOnce(prisma, input));
}

async function claimSteeringOnce(
  prisma: PrismaClient,
  input: ClaimSteeringInput,
): Promise<ClaimedSteeringMessage[]> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        threadId: input.threadId,
        botId: input.botId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        trigger: true,
        sourceMessage: { select: { blocks: true } },
      },
    });
    if (!run || run.trigger === "created") return [];
    const channelId =
      run.trigger === "messaging"
        ? messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined)
        : undefined;
    const directMessage = run.trigger === "messaging" && !channelId;
    // Pending rows from another chat stay for their own continuation.
    const pendingWhere = directMessage
      ? { runId: null, originTrigger: "messaging" }
      : channelId
        ? { runId: null, originTrigger: "messaging" }
        : { runId: null, originTrigger: null };
    const steering = await tx.steeringMessage.findMany({
      where: {
        botId: input.botId,
        // Only the run's own person's messages; anyone else's wait for a run of their own.
        userId: run.userId,
        id: input.seenIds.length ? { notIn: input.seenIds } : undefined,
        // A routine or webhook turn only takes steering addressed to it; pending user messages
        // wait for the conversational continuation that starts once it finishes.
        OR: isConversationalRun(run.trigger)
          ? [pendingWhere, { runId: input.runId }]
          : [{ runId: input.runId }],
        message: {
          threadId: input.threadId,
          // Private follow-ups remain unclaimed for the existing private continuation.
          ...(channelId
            ? { blocks: { array_contains: [{ kind: "channel_message", channelId }] } }
            : directMessage
              ? { NOT: { blocks: { array_contains: [{ kind: "channel_message" }] } } }
              : {}),
        },
      },
      include: { message: { select: { blocks: true, seq: true } } },
      orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
    });
    if (steering.length === 0) return [];
    await tx.steeringMessage.updateMany({
      where: { id: { in: steering.map((item) => item.id) }, claimedAt: null },
      data: { runId: input.runId, claimedAt: new Date() },
    });
    // The thread lock serializes this watermark with message writes. Unlike claim
    // timestamps, it cannot drift from the database clock or tie with a reply.
    const { nextMessageSeq } = await tx.thread.findUniqueOrThrow({
      where: { id: input.threadId },
      select: { nextMessageSeq: true },
    });
    await appendEventInTransaction(tx, {
      threadId: input.threadId,
      spaceId: run.spaceId,
      botId: input.botId,
      runId: input.runId,
      type: "run.steering.claimed",
      payload: { steeringIds: steering.map((item) => item.id), nextMessageSeq },
    });
    // In a group chat the row's user is the bot's owner, not the sender, so the sender is
    // matched by the address it wrote from.
    const groupSenders = steering.flatMap((item) =>
      (item.message.blocks as MessageBlock[]).filter((block) => block.kind === "channel_message"),
    );
    const ownAddresses = new Set(
      groupSenders.length === 0
        ? []
        : (
            await tx.messagingIdentity.findMany({
              where: {
                userId: run.userId,
                OR: groupSenders.map((block) => ({
                  provider: block.provider,
                  address: block.fromAddress,
                })),
              },
              select: { provider: true, address: true },
            })
          ).map((identity) => `${identity.provider}:${identity.address}`),
    );
    const sentByRunPerson = (item: (typeof steering)[number]) => {
      const group = (item.message.blocks as MessageBlock[]).find(
        (block) => block.kind === "channel_message",
      );
      return group
        ? ownAddresses.has(`${group.provider}:${group.fromAddress}`)
        : item.userId === run.userId;
    };
    return steering.map((item) => ({
      id: item.id,
      messageId: item.messageId,
      text: blocksToAgentHistoryText(item.message.blocks as MessageBlock[]),
      blocks: item.message.blocks as MessageBlock[],
      origin:
        item.originTrigger === "webhook"
          ? ("webhook" as const)
          : sentByRunPerson(item)
            ? ("user" as const)
            : item.originTrigger === "messaging"
              ? ("messaging" as const)
              : ("member" as const),
    }));
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

export async function discardAnsweredSteering(
  tx: Prisma.TransactionClient,
  input: { threadId: string; runId: string },
) {
  const lastReply = await tx.message.findFirst({
    where: {
      threadId: input.threadId,
      runId: input.runId,
      role: "bot",
      blocks: { array_contains: [{ kind: "text" }] },
      NOT: ["ask", "computer", "steps", "subagent"].map((kind) => ({
        blocks: { array_contains: [{ kind }] },
      })),
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (!lastReply) return;
  const claims = await tx.event.findMany({
    where: { threadId: input.threadId, runId: input.runId, type: "run.steering.claimed" },
    select: { payload: true },
  });
  const answeredIds = new Set<string>();
  for (const claim of claims) {
    const payload = claim.payload as { steeringIds?: unknown; nextMessageSeq?: unknown } | null;
    if (!payload || !Array.isArray(payload.steeringIds)) continue;
    for (const id of payload.steeringIds) {
      if (typeof id !== "string") continue;
      if (typeof payload.nextMessageSeq === "number" && payload.nextMessageSeq <= lastReply.seq) {
        answeredIds.add(id);
      }
    }
  }
  // Old runs without a durable claim watermark are deliberately replayed.
  if (answeredIds.size === 0) return;
  await tx.steeringMessage.deleteMany({
    where: { runId: input.runId, claimedAt: { not: null }, id: { in: [...answeredIds] } },
  });
}

/**
 * Queue one follow-up when this bot still has unclaimed steering and no live run. A Space being
 * deleted gets it too: its messages were accepted, and the executor holds the run until the
 * deletion ends or is called off.
 */
export async function createPendingSteeringRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string },
): Promise<string | null> {
  const active = await tx.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (active) return null;
  const pending = await tx.steeringMessage.findMany({
    where: {
      botId: input.botId,
      runId: null,
      message: { threadId: input.threadId },
    },
    include: { message: { select: { id: true, blocks: true, seq: true } } },
    orderBy: [{ message: { seq: "asc" } }, { id: "asc" }],
  });
  if (pending.length === 0) return null;
  // One origin per continuation so a group channel and the owner's private chat are not answered
  // together. The app and the owner's direct line are one private conversation, answered first.
  // One sender too: the run acts with that person's accounts, and the rest get their own
  // continuation next.
  const origin = pending.some((item) => steeringOrigin(item) === "private")
    ? "private"
    : steeringOrigin(pending[0]!);
  const userId = pending.find((item) => steeringOrigin(item) === origin)!.userId;
  const batch = pending.filter((item) => steeringOrigin(item) === origin && item.userId === userId);
  const source = batch.at(-1)!;
  const modelPin = continuationModelPin(batch);
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId,
      prompt:
        origin === "webhook"
          ? blocksToAgentHistoryText(source.message.blocks as MessageBlock[])
          : STEERING_CONTINUATION_PROMPT,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId,
      status: "queued",
      // A private continuation is a follow-up the owner wrote only when every message in it came
      // from the app; one direct-line delivery keeps it messaging, so it is never owner-started.
      // Rows queued before origins were recorded are recognized by their channel message.
      trigger:
        origin === "webhook"
          ? "webhook"
          : origin === "private" &&
              batch.every(
                (item) => item.originTrigger === null && !hasChannelMessage(item.message.blocks),
              )
            ? "follow_up"
            : "messaging",
      sourceMessageId: source.message.id,
      ...(modelPin ?? {}),
    },
  });
  await tx.steeringMessage.updateMany({
    where: { id: { in: batch.map((item) => item.id) }, runId: null },
    data: { runId: run.id, claimedAt: null },
  });
  return run.id;
}

function continuationModelPin(
  batch: ReadonlyArray<{
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  }>,
) {
  const first = batch[0];
  if (!first?.modelProvider || !first.modelId) return null;
  const agreed = batch.every(
    (item) =>
      item.modelProvider === first.modelProvider &&
      item.modelId === first.modelId &&
      (item.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  if (!agreed) return null;
  return {
    modelProvider: first.modelProvider,
    modelId: first.modelId,
    thinkingLevel: first.thinkingLevel ?? null,
    modelPinned: true,
  };
}

export function hasChannelMessage(blocks: unknown): boolean {
  return (blocks as MessageBlock[]).some((block) => block.kind === "channel_message");
}

function steeringOrigin(item: {
  originTrigger: string | null;
  message: { blocks: unknown };
}): string {
  if (item.originTrigger === "webhook") return "webhook";
  if (item.originTrigger !== "messaging") return "private";
  const channelId = messagingChannelId(item.message.blocks as MessageBlock[] | undefined);
  return channelId ? `channel:${channelId}` : "private";
}
