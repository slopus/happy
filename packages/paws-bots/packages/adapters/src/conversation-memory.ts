import type {
  BackgroundJobPayloads,
  JobPublisher,
  SemanticMemoryConversationTurn,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import { memoryRetainTurnJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  effectiveMemoryScope,
  isPartialReplyClientNonce,
  loadMessageAuthor,
  loadMessageAuthors,
  partialReplyClientNonce,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { messageBlocksText } from "./run-replies.js";
import { isUserProgressClientNonce, USER_PROGRESS_CLIENT_NONCE_PREFIX } from "./user-progress.js";

/** A person or another bot talking to the bot; routines, webhooks and channels are not. */
export const CONVERSATION_MEMORY_TRIGGERS: ReadonlySet<string> = new Set([
  "user",
  "messaging",
  "follow_up",
  "bot_message",
]);

/**
 * The bot's own direct thread and every group chat it takes part in: clearing either purges what
 * the bot learned there.
 */
export function retainsConversationTurn(input: {
  trigger: string;
  sourceMessageId: string | null;
  runBotId: string;
  threadBotId: string | null;
  threadGroupId: string | null;
  nonOwnerChatRun: boolean;
  provider: SemanticMemoryProvider | null;
}): boolean {
  return (
    input.provider?.retainConversation !== undefined &&
    !input.nonOwnerChatRun &&
    CONVERSATION_MEMORY_TRIGGERS.has(input.trigger) &&
    Boolean(input.sourceMessageId) &&
    (input.threadBotId === input.runBotId || input.threadGroupId !== null)
  );
}

/** At most this many messages are sent for one learned turn. */
const MAX_CONVERSATION_MESSAGES = 200;
/** Transcript cap per turn, shared by direct and group learning. */
const MAX_CONVERSATION_CHARS = 32_000;
/** A single longer message is cut to a marked excerpt of this many characters. */
const MAX_CONVERSATION_MESSAGE_CHARS = 8_000;
const EXCERPT_MARKER = " […]";

type SaidMessage = {
  seq: number;
  blocks: unknown;
  createdAt: Date;
  role: "user" | "assistant";
  speaker?: string;
  botId?: string | null;
  authorUserId?: string | null;
  text?: { content: string; speaker?: string };
};

/** Cuts text to its first `max` characters plus a marker, never splitting a surrogate pair. */
function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${EXCERPT_MARKER}`;
}

/**
 * Cuts oversized messages, then keeps the newest that fit the shared transcript cap. This run's
 * replies take at most half of it, newest first, so long replies never crowd out what people
 * said; everyone else's messages get the rest.
 */
function capConversationWindow(messages: SaidMessage[]): SaidMessage[] {
  const newestFirst = messages
    .map((message) => {
      const text = conversationText(message.blocks);
      return {
        ...message,
        text: { ...text, content: excerpt(text.content, MAX_CONVERSATION_MESSAGE_CHARS) },
      };
    })
    .filter((message) => message.text.content.length > 0)
    .sort((a, b) => b.seq - a.seq);
  const keepNewest = (role: SaidMessage["role"], budget: number, limit: number) => {
    const kept: SaidMessage[] = [];
    let used = 0;
    for (const message of newestFirst) {
      if (message.role !== role) continue;
      if (kept.length >= limit || used + message.text.content.length > budget) break;
      used += message.text.content.length;
      kept.push(message);
    }
    return { kept, used };
  };
  const replies = keepNewest(
    "assistant",
    MAX_CONVERSATION_CHARS / 2,
    MAX_CONVERSATION_MESSAGES / 2,
  );
  return [
    ...replies.kept,
    ...keepNewest(
      "user",
      MAX_CONVERSATION_CHARS - replies.used,
      MAX_CONVERSATION_MESSAGES - replies.kept.length,
    ).kept,
  ];
}

type ReceivedBotMessage = Extract<MessageBlock, { kind: "bot_message_received" }>;

function receivedBotMessage(blocks: unknown): ReceivedBotMessage | undefined {
  return (blocks as MessageBlock[]).find(
    (block): block is ReceivedBotMessage => block.kind === "bot_message_received",
  );
}

/**
 * Step and page ids, approval drafts and secret cards are not conversation. A message another bot
 * sent this bot is that bot's words.
 */
function conversationText(blocks: unknown): { content: string; speaker?: string } {
  const list = blocks as MessageBlock[];
  const received = receivedBotMessage(list);
  if (received) return { content: received.text.trim(), speaker: received.fromBotName };
  return { content: messageBlocksText(list).trim() };
}

/**
 * What the person sent while the run worked and the run claimed. Finalizing a completed run deletes
 * these claims, so read them first. Never throws: learning from a turn is optional.
 */
export async function answeredSteeringMessageIds(
  deps: { prisma: PrismaClient },
  runId: string,
): Promise<string[]> {
  try {
    const claims = await deps.prisma.steeringMessage.findMany({
      where: { runId, claimedAt: { not: null } },
      select: { messageId: true },
    });
    return claims.map((claim) => claim.messageId);
  } catch (error) {
    getLogger().error("memory.retain-turn could not read the run's answered messages", error);
    return [];
  }
}

type RetainDeps = { prisma: PrismaClient; memoryProviders: MemoryProviderResolver };

type PendingTurn = Omit<
  NonNullable<BackgroundJobPayloads["memory.retain-turn"]["pending"]>,
  "checks"
>;
export type RetainTurnResult = { pending?: PendingTurn };

/**
 * Sends one finished turn of a bot's conversation to the Space's memory provider. In the bot's
 * direct thread: the message that started the run, what was added while it worked, and the
 * replies. In a group chat: everything the room said since the bot last replied, and the replies.
 * These turns are derived knowledge, never instruction authority. Exposure does not suppress
 * learning: people's and bots' words remain usable, and semantic recall returns them as derived
 * data.
 *
 * Cleanup is scheduled before submitting any data. The returned pending state replaces that
 * watchdog with confirmed submission status, so a clear is purged once the write settles.
 */
export async function retainRunConversation(
  deps: RetainDeps & { jobs: JobPublisher },
  runId: string,
  answeredMessageIds: readonly string[] = [],
): Promise<RetainTurnResult> {
  const done: RetainTurnResult = {};
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      botId: true,
      threadId: true,
      userId: true,
      sourceMessageId: true,
    },
  });
  if (!run?.sourceMessageId) return done;
  const thread = await deps.prisma.thread.findUnique({
    where: { id: run.threadId },
    select: { botId: true, groupId: true, spaceId: true, historyCompactionGeneration: true },
  });
  if (!thread || thread.spaceId !== run.spaceId || (thread.botId !== run.botId && !thread.groupId))
    return done;
  const inGroup = Boolean(thread.groupId);
  const configured = await deps.memoryProviders.resolve(run.spaceId);
  const provider = configured?.provider;
  if (!configured || !provider?.retainConversation) return done;
  const connectionIdentity = provider.connectionIdentity;
  if (!connectionIdentity?.trim()) {
    throw new Error("Conversation retention requires a stable connection identity.");
  }
  const [source, steered, replies, bot] = await Promise.all([
    deps.prisma.message.findFirst({
      // In a group chat another bot's handoff can start the run.
      where: {
        id: run.sourceMessageId,
        threadId: run.threadId,
        ...(inGroup ? {} : { role: "user" }),
      },
      select: { id: true, seq: true, blocks: true, createdAt: true, authorUserId: true },
    }),
    answeredMessageIds.length && !inGroup
      ? deps.prisma.message.findMany({
          where: { id: { in: [...answeredMessageIds] }, threadId: run.threadId, role: "user" },
          select: { id: true, seq: true, blocks: true, createdAt: true, authorUserId: true },
        })
      : [],
    deps.prisma.message.findMany({
      where: { runId: run.id, threadId: run.threadId, role: "bot" },
      orderBy: { seq: "asc" },
      select: { seq: true, blocks: true, createdAt: true, clientNonce: true },
    }),
    deps.prisma.bot.findUnique({
      where: { id: run.botId },
      select: { name: true, memoryScope: true, userId: true },
    }),
  ]);
  // A cleared thread no longer has the message the turn answered.
  if (!source || !bot) return done;
  const author = await loadMessageAuthor(deps.prisma, source.authorUserId ?? run.userId);
  // Interim progress beats are status narration, and a partial reply was cut off by an error.
  const kept = replies.filter(
    (reply) =>
      !isPartialReplyClientNonce(reply.clientNonce) &&
      !isUserProgressClientNonce(reply.clientNonce),
  );
  const said: SaidMessage[] = [];
  if (inGroup) {
    // The window ends at this run's last reply, so a run that never replied has no turn.
    const lastReply = kept.at(-1);
    if (!lastReply) return done;
    const room = await groupWindow(deps.prisma, run, source.seq, lastReply.seq);
    said.push(...room);
  } else {
    said.push(
      { ...source, role: "user" },
      ...steered
        .filter((message) => message.id !== source.id)
        .map((message) => ({ ...message, role: "user" as const })),
      ...kept.map((reply) => ({ ...reply, role: "assistant" as const })),
    );
  }
  const selected = capConversationWindow(said);
  // Keep different people's words separate instead of attributing the whole turn to its starter.
  const humans = selected.filter(
    (message) => message.role === "user" && !receivedBotMessage(message.blocks) && !message.speaker,
  );
  const authorIds = [
    ...new Set([
      source.authorUserId ?? run.userId,
      ...humans.flatMap((message) => (message.authorUserId ? [message.authorUserId] : [])),
    ]),
  ];
  if (authorIds.length > 1) {
    const authors = await loadMessageAuthors(deps.prisma, authorIds);
    for (const message of humans) {
      message.speaker = message.authorUserId
        ? authors.get(message.authorUserId)?.name || "another person"
        : "another person";
    }
  }
  selected.sort((a, b) => a.seq - b.seq);
  // In the order it happened, with consecutive messages from one speaker joined.
  const turns: SemanticMemoryConversationTurn[] = [];
  let previousSpeakerIdentity: string | undefined;
  for (const message of selected) {
    const text = message.text ?? conversationText(message.blocks);
    if (!text.content) continue;
    const speaker = message.speaker ?? text.speaker;
    const timestamp = message.createdAt.toISOString();
    const sender = receivedBotMessage(message.blocks);
    const speakerIdentity =
      message.role === "assistant"
        ? `bot:${run.botId}`
        : sender || message.botId
          ? `bot:${sender?.fromBotId ?? message.botId}`
          : `user:${message.authorUserId ?? (inGroup ? `unknown:${message.seq}` : run.userId)}`;
    const previous = turns.at(-1);
    if (
      previous?.role === message.role &&
      previous.speaker === speaker &&
      previousSpeakerIdentity === speakerIdentity
    ) {
      previous.content = `${previous.content}\n\n${text.content}`;
      previous.timestamp = timestamp;
    } else {
      turns.push({
        role: message.role,
        content: text.content,
        timestamp,
        ...(speaker === undefined ? {} : { speaker }),
      });
    }
    previousSpeakerIdentity = speakerIdentity;
  }
  if (
    !turns.some((turn) => turn.role === "user") ||
    !turns.some((turn) => turn.role === "assistant")
  ) {
    return done;
  }
  const generation = thread.historyCompactionGeneration;
  const context = retainContext(run);
  const pending: PendingTurn = {
    generation,
    connectionIdentity,
    source: { spaceId: run.spaceId, userId: run.userId, botId: run.botId, threadId: run.threadId },
  };
  // Persist cleanup before the network side effect. If this process dies before saving the
  // provider's token, this job survives even when clear/group deletion removes the source run.
  await deps.jobs.enqueue(
    memoryRetainTurnJob(runId, [], {
      pending: { ...pending, unconfirmed: true, checks: 0 },
      availableAt: new Date(Date.now() + 5_000),
    }),
  );
  const result = await provider.retainConversation(
    {
      botId: run.botId,
      botName: bot.name || "the assistant",
      userName: author?.name || "the user",
      scope: effectiveMemoryScope(bot.memoryScope, configured.defaultScope),
      threadId: run.threadId,
      conversation: thread.groupId ? "group" : "direct",
      generation,
      runId,
      turns,
    },
    context,
  );
  // Retrying is safe: the provider makes a repeated turn a no-op.
  if (!result.ok) throw new Error(result.error);
  if (result.value.pending) return { pending: { ...pending, token: result.value.pending } };
  try {
    await purgeIfCleared(deps.prisma, provider, run, generation, context);
  } catch (error) {
    // A retry would rebuild the turn from messages the clear deleted, and skip it: hand back the
    // stored generation so a later check purges it.
    getLogger().error("memory.retain-turn could not purge a cleared conversation", error);
    return { pending };
  }
  // Replace the pre-submission watchdog even when the provider stored synchronously.
  return { pending };
}

/**
 * Whether a turn the provider was still storing is stored now. Once it is, a clear that landed
 * meanwhile is purged; a failed purge throws so the check runs again. Without a token the turn
 * is already stored and only the purge is left. Captured source IDs also allow cleanup after
 * group deletion removes the run. A changed or revoked connection ends this best-effort cleanup.
 */
export async function settleRetainedConversation(
  deps: RetainDeps,
  runId: string,
  pending: PendingTurn,
): Promise<{ settled: boolean }> {
  if (pending.unconfirmed) {
    // An ambiguous write only needs remote cleanup after clear/deletion. Avoid resolving
    // credentials or contacting the service while its conversation and retaining bot still exist.
    if (await retainedConversationStillCurrent(deps.prisma, pending.source, pending.generation)) {
      return { settled: false };
    }
  }
  const found = await retainedRunProvider(deps, runId, pending);
  if (!found) return { settled: true };
  const { run, provider } = found;
  const context = retainContext(run);
  if (pending.token && provider.retainedConversationSettled) {
    const result = await provider.retainedConversationSettled(pending.token, context);
    if (!result.ok) throw new Error(result.error);
    if (!result.value.settled) return { settled: false };
  }
  await purgeIfCleared(deps.prisma, provider, run, pending.generation, context);
  // Without the submission response we cannot know when a remote write finishes. Keep checking
  // through the bounded cleanup window, including after an early purge found nothing yet.
  return { settled: pending.unconfirmed !== true };
}

/**
 * Stops waiting for a turn the provider never finished storing. If the chat was cleared
 * meanwhile, purge its generation once more: the write may have landed after the clear's purge.
 * Best effort, since nothing checks again after this.
 */
export async function abandonRetainedConversation(
  deps: RetainDeps,
  runId: string,
  pending: PendingTurn,
): Promise<void> {
  try {
    const found = await retainedRunProvider(deps, runId, pending);
    if (!found) return;
    const { run, provider } = found;
    await purgeIfCleared(deps.prisma, provider, run, pending.generation, retainContext(run));
  } catch (error) {
    getLogger().error("memory.retain-turn could not purge a cleared conversation", error);
  }
}

async function retainedRunProvider(
  deps: RetainDeps,
  runId: string,
  pending: PendingTurn,
): Promise<{ run: RetainRun; provider: SemanticMemoryProvider } | undefined> {
  const run = { id: runId, ...pending.source };
  const provider = (await deps.memoryProviders.resolve(run.spaceId))?.provider;
  if (!provider || provider.connectionIdentity !== pending.connectionIdentity) {
    getLogger().warn("memory.retain-turn stopped after its memory connection changed");
    return undefined;
  }
  return { run, provider };
}

type RetainRun = { id: string; spaceId: string; botId: string; threadId: string; userId: string };

function retainContext(run: RetainRun) {
  const operationId = `memory.retain-turn:${run.id}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    runId: run.id,
    signal: new AbortController().signal,
  };
}

/**
 * A clear or bot deletion can purge while a turn is still being stored. Purge again after the
 * write settles; failures throw so the caller retries.
 */
async function purgeIfCleared(
  prisma: PrismaClient,
  provider: SemanticMemoryProvider,
  run: RetainRun,
  generation: number,
  context: ReturnType<typeof retainContext>,
): Promise<void> {
  if (await retainedConversationStillCurrent(prisma, run, generation)) return;
  const removed = await provider.purgeHistory(
    { botId: run.botId, threadId: run.threadId, generations: [generation] },
    context,
  );
  if (!removed.ok) {
    throw new Error(`memory.retain-turn could not purge a cleared conversation: ${removed.error}`);
  }
}

async function retainedConversationStillCurrent(
  prisma: PrismaClient,
  source: { threadId: string; botId: string },
  generation: number,
): Promise<boolean> {
  const latest = await prisma.thread.findUnique({
    where: { id: source.threadId },
    select: { historyCompactionGeneration: true, botId: true },
  });
  if (latest?.historyCompactionGeneration !== generation) return false;
  if (latest.botId === source.botId) return true;
  // A group can survive its retaining bot. Late writes must still be purged after bot deletion.
  return Boolean(
    await prisma.bot.findUnique({ where: { id: source.botId }, select: { id: true } }),
  );
}

/**
 * What a group chat said from just after this bot's previous reply through this run's last reply:
 * people's messages, other bots' messages under their names, and this run's replies.
 */
async function groupWindow(
  prisma: PrismaClient,
  run: { id: string; botId: string; threadId: string; spaceId: string },
  sourceSeq: number,
  lastReplySeq: number,
): Promise<SaidMessage[]> {
  const conversationalReply = {
    OR: [
      { clientNonce: null },
      {
        NOT: {
          OR: [
            { clientNonce: { startsWith: partialReplyClientNonce("") } },
            { clientNonce: { startsWith: USER_PROGRESS_CLIENT_NONCE_PREFIX } },
          ],
        },
      },
    ],
  };
  const previousReply = await prisma.message.findFirst({
    where: {
      threadId: run.threadId,
      role: "bot",
      botId: run.botId,
      OR: [{ runId: null }, { runId: { not: run.id } }],
      seq: { lt: sourceSeq },
      AND: [conversationalReply],
    },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const messages = await prisma.message.findMany({
    where: {
      threadId: run.threadId,
      seq: { gt: previousReply?.seq ?? -1, lte: lastReplySeq },
      OR: [
        { role: "user" },
        {
          role: "bot",
          AND: [
            conversationalReply,
            {
              OR: [{ botId: null }, { botId: { not: run.botId } }, { runId: run.id }],
            },
          ],
        },
      ],
    },
    orderBy: { seq: "desc" },
    take: MAX_CONVERSATION_MESSAGES,
    select: {
      seq: true,
      role: true,
      blocks: true,
      createdAt: true,
      botId: true,
      runId: true,
      clientNonce: true,
      authorUserId: true,
    },
  });
  const otherBotIds = [
    ...new Set(
      messages.flatMap((message) =>
        message.role === "bot" && message.botId && message.botId !== run.botId
          ? [message.botId]
          : [],
      ),
    ),
  ];
  const otherBots = otherBotIds.length
    ? await prisma.bot.findMany({
        where: { id: { in: otherBotIds }, spaceId: run.spaceId },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(otherBots.map((other) => [other.id, other.name]));
  return messages.map((message) => {
    if (message.role === "user") return { ...message, role: "user" as const };
    if (message.botId === run.botId) return { ...message, role: "assistant" as const };
    return {
      ...message,
      role: "user" as const,
      speaker: names.get(message.botId ?? "") || "another assistant",
    };
  });
}
