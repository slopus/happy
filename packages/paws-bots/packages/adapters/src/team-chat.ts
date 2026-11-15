import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  messagingReplyJob,
  runContinueJob,
  teamChatAmbientJob,
  teamChatEngageJob,
  teamChatEngageJobKey,
} from "@rakazo/adapter-kit";
import type { AutomatedSenderPolicies, MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT, AutomatedSenderPoliciesSchema } from "@rakazo/contracts";
import {
  messageBlockForArtifact,
  promptTextForAttachments,
  teamChatAmbientPrompt,
  teamChatPrompt,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  runAsSystem,
  SendClaimLostError,
  SpaceDeletionInProgressError,
  teamChatRunClientNonce,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { inboundDeliveryClientNonce, messagingWakeIdempotencyKey } from "./inbound-delivery.js";
import type { TeamChatEngagementJudge } from "./team-chat-judge.js";

/** A received message's run starts at once; its backup job takes over after this. */
export const TEAM_CHAT_ENGAGE_BACKUP_MS = 60_000;

/**
 * How long routine routing owns a message. Past it, with no routine woken, the message's job
 * answers it with the agent. A routine and the agent can never both take it: each claims the
 * message in the transaction that starts its run.
 */
export const TEAM_CHAT_ROUTING_MS = 2 * 60_000;

/** Ambient messages wait for this much quiet in their conversation before the judge reads them. */
const DEFAULT_AMBIENT_DEBOUNCE_MS = 15_000;
const AMBIENT_BATCH_SIZE = 100;
const AMBIENT_CONTEXT_MESSAGES = 20;
/** Messages stuck this long in a waiting state have lost the job that moves them on. */
const STALLED_MESSAGE_MS = 5 * 60_000;
const SWEEP_BATCH = 100;

export interface TeamChatDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage">;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancel" | "cancelIn">;
  judge?: TeamChatEngagementJudge;
  /** Whether a connected workspace still has the bot installed; unknown ids count as gone. */
  isInstallationActive?: (installationId: string) => Promise<boolean>;
  ambientDebounceMs?: number;
}

type Conversation = {
  id: string;
  provider: string;
  conversationId: string;
  displayName: string | null;
  spaceId: string;
  botId: string;
  userId: string;
  thread: { id: string } | null;
};

type TeamChatMessage = {
  id: string;
  providerEventId: string;
  kind: string;
  senderId: string;
  senderName: string;
  content: string;
  status: string;
  batchContext: string | null;
  threadMessageId: string | null;
  externalConversation: Conversation;
};

/** Files kept from a message, and the names of the ones that could not be. */
export interface TranscriptFiles {
  artifacts: Array<{ id: string; name: string; mimeType: string; size: number }>;
  unavailable: string[];
}

const CONVERSATION = {
  id: true,
  provider: true,
  conversationId: true,
  displayName: true,
  spaceId: true,
  botId: true,
  userId: true,
  thread: { select: { id: true } },
} as const;

const AMBIENT_CONVERSATION = {
  ...CONVERSATION,
  teamChatAmbientEnabled: true,
  teamChatRules: true,
  automatedSenderPolicies: true,
} as const;

type AmbientConversation = Prisma.ExternalConversationGetPayload<{
  select: typeof AMBIENT_CONVERSATION;
}>;

type AmbientMessage = Prisma.ExternalMessageGetPayload<{
  include: { externalConversation: { select: typeof CONVERSATION } };
}>;

type AmbientBot = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  modelProvider: string | null;
  modelId: string | null;
  teamChatAmbientEnabled: boolean;
  teamChatRules: string;
};

/** Digest senders whose period has not passed, and when the first of them falls due. */
type WaitingDigests = { senders: string[]; nextDueAt: number };

const NO_WAITING_DIGESTS: WaitingDigests = { senders: [], nextDueAt: Number.POSITIVE_INFINITY };

/** Unanswered messages an ambient pass can decide now: all but waiting digests. */
function decidable(digests: WaitingDigests): Prisma.ExternalMessageWhereInput {
  return {
    status: "observed",
    ...(digests.senders.length > 0
      ? { NOT: { senderIsBot: true, senderId: { in: digests.senders } } }
      : {}),
  };
}

/** Serializes everyone who schedules one conversation's ambient decision. */
async function lockAmbientSchedule(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`team_chat.ambient:${conversationId}`}, 0))`;
}

/** The transcript-file nonce for one of a team-chat message's attachments. */
export function teamChatAttachmentNonce(externalMessageId: string, index: number): string {
  return `teamchat-attachment:${externalMessageId}:${index}`;
}

/**
 * Answers inbound team-chat messages. The API process that receives a message records it with a
 * backup job, then mirrors and answers it at once; ambient messages wait for one scheduled
 * decision per conversation. The jobs here run only when that process could not finish, when
 * routine routing ran out of time, and when a quiet conversation is due for its decision.
 */
export class TeamChat {
  constructor(private readonly deps: TeamChatDeps) {}

  /**
   * Copies a message into the bot's Rakazo thread before anything answers it. With `files`, the
   * receiving process stored its attachments; without, uploads an earlier attempt finished are
   * reused, since attachment fetchers do not survive a restart.
   */
  async mirrorTranscript(message: TeamChatMessage, files?: TranscriptFiles): Promise<void> {
    if (message.threadMessageId) return;
    const conversation = message.externalConversation;
    if (!conversation.thread) throw new Error("Team chat conversation has no Rakazo thread");
    const stored = files ?? {
      artifacts: await this.deps.prisma.artifact.findMany({
        where: {
          spaceId: conversation.spaceId,
          userId: conversation.userId,
          botId: conversation.botId,
          groupId: null,
          clientNonce: {
            in: Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, index) =>
              teamChatAttachmentNonce(message.id, index),
            ),
          },
        },
        select: { id: true, name: true, mimeType: true, size: true },
        orderBy: { clientNonce: "asc" },
      }),
      unavailable: [],
    };
    const text =
      [message.content.trim(), ...stored.unavailable].filter(Boolean).join("\n") ||
      (stored.artifacts.length ? "" : "[file (unavailable)]");
    const visible = await this.deps.events.sendUserMessage({
      spaceId: conversation.spaceId,
      threadId: conversation.thread.id,
      botId: conversation.botId,
      userId: conversation.userId,
      blocks: [
        ...(text ? [{ kind: "text" as const, text }] : []),
        ...stored.artifacts.map((artifact) => messageBlockForArtifact(artifact)),
      ],
      prompt: promptTextForAttachments(text, stored.artifacts),
      trigger: "messaging",
      clientNonce: `teamchat-transcript:${conversation.provider}:${message.providerEventId}`,
      createRun: false,
    });
    await this.deps.prisma.externalMessage.update({
      where: { id: message.id },
      data: { threadMessageId: visible.messageId },
    });
    message.threadMessageId = visible.messageId;
  }

  /**
   * Starts the agent run that answers a message, claiming it from one of `from` in the run's own
   * transaction, so a routine wake that claims it first rolls this back and the other way round.
   * A Space being deleted takes no run: the message is dropped and its transcript stays.
   */
  async startAgentRun(externalMessageId: string, from: string[]): Promise<void> {
    const message = await this.load(externalMessageId);
    if (!message || !from.includes(message.status)) return;
    const conversation = message.externalConversation;
    const thread = conversation.thread;
    if (!thread) throw new Error("Team chat conversation has no Rakazo thread");
    // A routine the previous release woke without claiming the message already answers it.
    if (await this.routineWoken(message)) {
      await this.settle(message.id, from, {
        status: "ignored",
        engagementReason: "message_routine_wake",
      });
      return;
    }
    await this.mirrorTranscript(message);
    const batch = readBatchContext(message.batchContext);
    const prompt =
      batch?.prompt ?? teamChatPrompt(conversation.provider, message.senderName, message.content);
    const transcripts = await this.deps.prisma.message.findMany({
      where: {
        threadId: thread.id,
        externalTranscriptFor: {
          id: { in: batch?.messageIds.length ? batch.messageIds : [message.id] },
        },
      },
      select: { blocks: true },
      orderBy: { seq: "asc" },
    });
    const fileBlocks = transcripts
      .flatMap(({ blocks }) =>
        (blocks as MessageBlock[]).filter(
          (block) => block.kind === "file" || block.kind === "image",
        ),
      )
      .slice(-ATTACHMENT_MAX_COUNT);
    const link = (runId: string) => ({ status: "running", runId });
    let sent: Awaited<ReturnType<TeamChatDeps["events"]["sendUserMessage"]>>;
    try {
      sent = await this.deps.events.sendUserMessage({
        spaceId: conversation.spaceId,
        threadId: thread.id,
        botId: conversation.botId,
        userId: conversation.userId,
        blocks: [{ kind: "text", text: prompt }, ...fileBlocks],
        prompt,
        trigger: "messaging",
        clientNonce: teamChatRunClientNonce(conversation.provider, message.providerEventId),
        linkMessageToRun: true,
        allowParallelRun: true,
        claim: async (tx, { runId }) => {
          if (!runId) return false;
          const claimed = await tx.externalMessage.updateMany({
            where: { id: message.id, status: { in: from } },
            data: link(runId),
          });
          if (claimed.count !== 1) return false;
          await this.deps.jobs.cancelIn(tx, teamChatEngageJobKey(message.id));
          return true;
        },
      });
    } catch (error) {
      if (error instanceof SendClaimLostError) return;
      if (error instanceof SpaceDeletionInProgressError) {
        await this.settle(message.id, from, { status: "ignored" });
        getLogger().info("messaging inbound dropped", { reason: "space being deleted" });
        return;
      }
      throw error;
    }
    if (!sent.runId) throw new Error("Team chat message did not create an agent run");
    // A replayed send skipped its claim; one that committed without the link is linked now.
    await this.settle(message.id, from, link(sent.runId), { runId: null });
    await this.deps.jobs.enqueue(runContinueJob(sent.runId));
  }

  /**
   * Routine routing found no routine to wake: the agent answers, or for an ambient message, the
   * conversation's next decision includes it. A message already settled is left alone.
   */
  async routeToAgent(externalMessageId: string, kind: string): Promise<void> {
    if (kind !== "ambient") {
      await this.startAgentRun(externalMessageId, ["deferred"]);
      return;
    }
    const message = await this.load(externalMessageId);
    if (!message) return;
    await this.deps.prisma.$transaction(async (tx) => {
      const observed = await tx.externalMessage.updateMany({
        where: { id: message.id, status: "deferred" },
        data: { status: "observed" },
      });
      if (observed.count !== 1) return;
      await this.scheduleAmbientIn(tx, message.externalConversation.id);
      await this.deps.jobs.cancelIn(tx, teamChatEngageJobKey(message.id));
    });
  }

  /** Nobody answers the message, such as one for a Space being deleted; its transcript stays. */
  async drop(externalMessageId: string, from: string[]): Promise<void> {
    await this.settle(externalMessageId, from, { status: "ignored" });
  }

  /** Schedules the conversation's ambient decision once it has been quiet, as part of `tx`. */
  async scheduleAmbientIn(tx: Prisma.TransactionClient, conversationId: string): Promise<void> {
    await lockAmbientSchedule(tx, conversationId);
    await this.deps.jobs.enqueueIn(
      tx,
      teamChatAmbientJob(conversationId, new Date(Date.now() + this.debounceMs)),
    );
  }

  /**
   * A message's backup job: the process that received it could not finish, or routine routing
   * ran out of time without waking a routine.
   */
  async engageJob(externalMessageId: string): Promise<void> {
    await runAsSystem("answer a team-chat message", async () => {
      const message = await this.load(externalMessageId);
      if (!message) return;
      // A workspace that removed the bot gets no answer.
      if (!(await this.available(message.externalConversation))) {
        await this.drop(message.id, ["received", "queueing", "deferred"]);
        return;
      }
      await this.mirrorTranscript(message);
      if (message.status === "received") await this.startAgentRun(message.id, ["received"]);
      // The previous release's queueing claim, left by a process that stopped mid-way.
      else if (message.status === "queueing") await this.startAgentRun(message.id, ["queueing"]);
      else if (message.status === "deferred") await this.routeToAgent(message.id, message.kind);
    });
  }

  /**
   * One conversation's ambient decision over its unanswered messages, a batch at a time. A digest
   * sender's messages stay out of the batch until its period passes, so they never hold up anything
   * behind them. Where the bot no longer answers, every waiting message is ignored, digests too.
   */
  async ambientJob(conversationId: string): Promise<void> {
    await runAsSystem("decide on ambient team-chat messages", async () => {
      const conversation = await this.deps.prisma.externalConversation.findUnique({
        where: { id: conversationId },
        select: AMBIENT_CONVERSATION,
      });
      if (!conversation) return;
      const now = new Date();
      const available = await this.available(conversation);
      // An archived bot answers nothing more.
      const bot = available
        ? await this.deps.prisma.bot.findFirst({
            where: { id: conversation.botId, archivedAt: null },
            select: {
              id: true,
              spaceId: true,
              userId: true,
              name: true,
              modelProvider: true,
              modelId: true,
              teamChatAmbientEnabled: true,
              teamChatRules: true,
            },
          })
        : null;
      const policy =
        bot && (conversation.teamChatAmbientEnabled ?? bot.teamChatAmbientEnabled) ? bot : null;
      const parsedPolicies = AutomatedSenderPoliciesSchema.safeParse(
        conversation.automatedSenderPolicies,
      );
      const senderPolicies = parsedPolicies.success ? parsedPolicies.data : {};
      const digests = policy
        ? await this.waitingDigests(conversation.id, senderPolicies, now)
        : NO_WAITING_DIGESTS;
      const observed = await this.deps.prisma.externalMessage.findMany({
        where: { externalConversationId: conversation.id, ...decidable(digests) },
        include: { externalConversation: { select: CONVERSATION } },
        orderBy: { createdAt: "asc" },
        take: AMBIENT_BATCH_SIZE,
      });
      if (observed.length > 0) {
        if (available) for (const message of observed) await this.mirrorTranscript(message);
        if (policy) await this.decideAmbient(conversation, policy, senderPolicies, observed, now);
        else await this.markIgnored(observed, now);
      }
      await this.scheduleNextAmbient(conversation.id, digests);
    });
  }

  /**
   * Queues the conversation's next ambient decision: once it has been quiet while messages it can
   * decide remain, a batch's backlog included, else when the first waiting digest falls due. Under
   * the lock every scheduler takes, so a message recorded during this pass is either seen here or
   * schedules its own decision after, and a later time never replaces a sooner one.
   */
  private async scheduleNextAmbient(
    conversationId: string,
    digests: WaitingDigests,
  ): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      await lockAmbientSchedule(tx, conversationId);
      const newest = await tx.externalMessage.findFirst({
        where: { externalConversationId: conversationId, ...decidable(digests) },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const quietAt = newest
        ? Math.max(Date.now(), newest.createdAt.getTime() + this.debounceMs)
        : Number.POSITIVE_INFINITY;
      const nextAt = Math.min(quietAt, digests.nextDueAt);
      if (Number.isFinite(nextAt))
        await this.deps.jobs.enqueueIn(tx, teamChatAmbientJob(conversationId, new Date(nextAt)));
    });
  }

  /**
   * Decides one batch, once the conversation has been quiet: ignores it, or starts one run for the
   * message that needs the bot, with the others as context.
   */
  private async decideAmbient(
    conversation: AmbientConversation,
    policy: AmbientBot,
    senderPolicies: AutomatedSenderPolicies,
    observed: AmbientMessage[],
    now: Date,
  ): Promise<void> {
    // Blank room instructions follow the bot, as the settings screens show them.
    const rules = conversation.teamChatRules || policy.teamChatRules;
    const ignored = observed.filter(
      (message) =>
        message.senderIsBot && (senderPolicies[message.senderId]?.mode ?? "ignore") === "ignore",
    );
    await this.markIgnored(ignored, now);
    const evaluated = observed.filter((message) => !ignored.includes(message));
    const latest = evaluated.at(-1);
    if (!latest || latest.createdAt.getTime() + this.debounceMs > now.getTime()) return;
    const judged = evaluated.slice(-AMBIENT_CONTEXT_MESSAGES);
    const actionable = [...judged]
      .reverse()
      .find(
        (message) => message.senderIsBot && senderPolicies[message.senderId]?.mode === "action",
      );
    const decision = actionable
      ? {
          act: true,
          reason: `${actionable.senderName} is configured as actionable.`,
          askedByEventId: actionable.providerEventId,
        }
      : this.deps.judge
        ? await this.deps.judge.decide({
            bot: policy,
            channelId: conversation.conversationId,
            channelName: conversation.displayName ?? undefined,
            rules,
            messages: judged.map((message) => ({
              eventId: message.providerEventId,
              senderId: message.senderId,
              senderName: message.senderName,
              content: message.content,
            })),
          })
        : { act: false, reason: "Ambient engagement judge is unavailable." };
    if (!decision.act) {
      await this.markIgnored(evaluated, now);
      return;
    }
    const trigger =
      judged.find((message) => message.providerEventId === decision.askedByEventId) ?? latest;
    const promoted = await this.deps.prisma.$transaction(async (tx) => {
      const claimed = await tx.externalMessage.updateMany({
        where: { id: trigger.id, status: "observed" },
        data: {
          status: "received",
          judgedAt: now,
          engagementReason: decision.reason ?? null,
          batchContext: JSON.stringify({
            messageIds: judged.map(({ id }) => id),
            prompt: teamChatAmbientPrompt({
              provider: conversation.provider,
              channelId: conversation.conversationId,
              channelName: conversation.displayName,
              rules,
              reason: decision.reason,
              messages: judged.map((message) => ({
                senderId: message.senderId,
                senderName: message.senderName,
                content: message.content,
              })),
            }),
          }),
        },
      });
      if (claimed.count !== 1) return false;
      await this.deps.jobs.enqueueIn(
        tx,
        teamChatEngageJob(trigger.id, new Date(Date.now() + TEAM_CHAT_ENGAGE_BACKUP_MS)),
      );
      await tx.externalMessage.updateMany({
        where: {
          id: { in: evaluated.filter(({ id }) => id !== trigger.id).map(({ id }) => id) },
          status: "observed",
        },
        data: { status: "ignored", judgedAt: now },
      });
      return true;
    });
    if (promoted) await this.startAgentRun(trigger.id, ["received"]);
  }

  /**
   * Safety sweep for messages whose job is gone, such as ones the previous release recorded, or
   * held by a worker that died: waiting messages get their job back, and a run that ended
   * without its answer recorded gets its reply job. A job that is still waiting is left alone.
   */
  async sweepStalled(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - STALLED_MESSAGE_MS);
    const cursor = this.sweepCursor;
    const stalled = await this.deps.prisma.externalMessage.findMany({
      where: {
        updatedAt: { lt: before },
        OR: [
          { status: { in: ["received", "deferred", "queueing", "observed"] } },
          { status: "running", run: { status: { in: ["completed", "failed", "cancelled"] } } },
        ],
        // One page per pass, so messages that stay stalled cannot hide the ones behind them.
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    { updatedAt: { gt: cursor.at } },
                    { updatedAt: cursor.at, id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: SWEEP_BATCH,
      select: {
        id: true,
        status: true,
        runId: true,
        externalConversationId: true,
        updatedAt: true,
      },
    });
    const last = stalled.at(-1);
    this.sweepCursor =
      stalled.length === SWEEP_BATCH && last ? { at: last.updatedAt, id: last.id } : undefined;
    const recover = { keepExisting: true, replaceLockedBefore: before } as const;
    for (const message of stalled) {
      if (message.status === "running") {
        if (message.runId)
          await this.deps.jobs.enqueue({ ...messagingReplyJob(message.runId, now), ...recover });
      } else if (message.status === "observed") {
        await this.deps.jobs.enqueue({
          ...teamChatAmbientJob(message.externalConversationId, now),
          ...recover,
        });
      } else {
        await this.deps.jobs.enqueue({ ...teamChatEngageJob(message.id, now), ...recover });
      }
    }
  }

  private sweepCursor: { at: Date; id: string } | undefined;

  private get debounceMs(): number {
    return this.deps.ambientDebounceMs ?? DEFAULT_AMBIENT_DEBOUNCE_MS;
  }

  private load(externalMessageId: string): Promise<TeamChatMessage | null> {
    return this.deps.prisma.externalMessage.findUnique({
      where: { id: externalMessageId },
      select: {
        id: true,
        providerEventId: true,
        kind: true,
        senderId: true,
        senderName: true,
        content: true,
        status: true,
        batchContext: true,
        threadMessageId: true,
        externalConversation: { select: CONVERSATION },
      },
    });
  }

  /** A workspace that removed the bot gets no more answers; the static workspace always does. */
  private async available(conversation: { conversationId: string }): Promise<boolean> {
    const installationId = /^[^~:]+~([^:]+):/.exec(conversation.conversationId)?.[1];
    if (!installationId) return true;
    return (await this.deps.isInstallationActive?.(installationId)) ?? false;
  }

  private async routineWoken(message: TeamChatMessage): Promise<boolean> {
    const threadId = message.externalConversation.thread?.id;
    if (!threadId) return false;
    const wake = await this.deps.prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId,
          clientNonce: inboundDeliveryClientNonce(
            "messaging",
            message.externalConversation.botId,
            messagingWakeIdempotencyKey(
              message.externalConversation.provider,
              message.providerEventId,
            ),
          ),
        },
      },
      select: { id: true },
    });
    return wake !== null;
  }

  /** Moves a message on from one of `from`, and removes its backup job once it has. */
  private async settle(
    id: string,
    from: string[],
    data: Prisma.ExternalMessageUpdateManyMutationInput,
    where: Prisma.ExternalMessageWhereInput = {},
  ): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const settled = await tx.externalMessage.updateMany({
        where: { ...where, id, status: { in: from } },
        data,
      });
      if (settled.count === 1) await this.deps.jobs.cancelIn(tx, teamChatEngageJobKey(id));
    });
  }

  private async markIgnored(messages: Array<{ id: string }>, judgedAt: Date): Promise<void> {
    if (messages.length === 0) return;
    await this.deps.prisma.externalMessage.updateMany({
      where: { id: { in: messages.map(({ id }) => id) }, status: "observed" },
      data: { status: "ignored", judgedAt },
    });
  }

  /**
   * Digest senders with messages waiting here whose period has not passed, and when the first of
   * them falls due. A sender's period runs from the last time its messages were decided.
   */
  private async waitingDigests(
    conversationId: string,
    policies: AutomatedSenderPolicies,
    now: Date,
  ): Promise<WaitingDigests> {
    const digestSenders = Object.entries(policies)
      .filter(([, policy]) => policy.mode === "rollup")
      .map(([senderId]) => senderId);
    if (digestSenders.length === 0) return NO_WAITING_DIGESTS;
    const pending = await this.deps.prisma.externalMessage.groupBy({
      by: ["senderId"],
      where: {
        externalConversationId: conversationId,
        status: "observed",
        senderIsBot: true,
        senderId: { in: digestSenders },
      },
    });
    if (pending.length === 0) return NO_WAITING_DIGESTS;
    // Each sender's latest decision, one index lookup apiece, however long its history.
    const decided = await this.deps.prisma.$queryRaw<
      Array<{ senderId: string; judgedAt: Date | null }>
    >`
      SELECT s."senderId", last."judgedAt"
      FROM unnest(${pending.map(({ senderId }) => senderId)}::text[]) AS s("senderId")
      LEFT JOIN LATERAL (
        SELECT "judgedAt" FROM external_messages
        WHERE "externalConversationId" = ${conversationId} AND "senderId" = s."senderId"
          AND "senderIsBot" AND "judgedAt" IS NOT NULL
        ORDER BY "judgedAt" DESC
        LIMIT 1
      ) AS last ON true`;
    const waiting: WaitingDigests = { senders: [], nextDueAt: Number.POSITIVE_INFINITY };
    for (const { senderId } of pending) {
      const last = decided.find((row) => row.senderId === senderId)?.judgedAt;
      const dueAt =
        (last?.getTime() ?? 0) + (policies[senderId]?.rollupHours ?? 0) * 60 * 60 * 1000;
      if (dueAt <= now.getTime()) continue;
      waiting.senders.push(senderId);
      waiting.nextDueAt = Math.min(waiting.nextDueAt, dueAt);
    }
    return waiting;
  }
}

function readBatchContext(
  value: string | null,
): { prompt: string; messageIds: string[] } | undefined {
  if (!value) return undefined;
  try {
    const batch: unknown = JSON.parse(value);
    if (
      batch !== null &&
      typeof batch === "object" &&
      "prompt" in batch &&
      typeof batch.prompt === "string" &&
      "messageIds" in batch &&
      Array.isArray(batch.messageIds) &&
      batch.messageIds.every((id): id is string => typeof id === "string")
    )
      return { prompt: batch.prompt, messageIds: batch.messageIds };
  } catch {
    // Previously persisted batches contain only the plain prompt.
  }
  return { prompt: value, messageIds: [] };
}
