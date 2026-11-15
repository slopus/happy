import { ORPCError } from "@orpc/server";
import type {
  JobPublisher,
  NotificationProvider,
  ProductAnalytics,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { notifyMemberMessage } from "@rakazo/adapters";
import type { Actor, GroupMember, MessageBlock, ReplyPreview } from "@rakazo/contracts";
import {
  GROUP_MEMBER_MIN,
  MessageBlock as MessageBlockSchema,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  callIdFromClientNonce,
  isConversationalRun,
  isQuestionAskBlock,
  MODEL_REQUIRED_SEND_ERROR,
  memberMessageAlerts,
  mentionedGroupBotIds,
  messageBypassesTakeoverWait,
  QUEUE_HOLDING_RUN_STATUSES,
  resolveGroupTargetBotIds,
  runReadsThreadHistory,
} from "@rakazo/core";
import { deriveMessageQuote, messageReplyPreview } from "@rakazo/core/message-quote";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  answerWaitingRunWithTextInTransaction,
  appendEventInTransaction,
  clearEndedRunState,
  createGroupRepos,
  createRepos,
  createThreadMessageInTransaction,
  eligibleWaitingTextAnswer,
  IsolationError,
  loadMessageAuthor,
  lockSpaceGroup,
  primaryActiveRun,
  retireWaitingQuestionInTransaction,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  buildSendPrompt,
  buildUserMessageBlocks,
  resolveGroupSendAttachments,
  resolveSendAttachments,
} from "./artifacts.js";
import type { ImageAdmissionRun } from "./thread-image-admission.js";
import { assertThreadImageInput } from "./thread-image-admission.js";
import { cancelThreadRuns, finishThreadStop, isStopMessage } from "./thread-stop.js";

export type ThreadTarget =
  | {
      kind: "bot";
      botId: string;
      threadId: string;
      bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>;
    }
  | {
      kind: "group";
      groupId: string;
      threadId: string;
      groupName: string;
      members: GroupMember[];
      memberBotIds: string[];
    };

export const RUNS_NEEDING_CONTINUE = new Set(["queued", "waiting_takeover"]);

const STEERABLE_RUN_STATUSES = new Set<string>(QUEUE_HOLDING_RUN_STATUSES);
/**
 * An answer steers the waiting run it resumes when the model must see its image, or when the run
 * reads no thread history and would otherwise never get the attachment.
 */
function answerSteersRun(
  run: { trigger?: string | null },
  attachments: MessageBlock[],
  imageHandling: "confirm" | "file" | undefined,
) {
  return (
    (imageHandling === "confirm" && attachments.some((block) => block.kind === "image")) ||
    (attachments.length > 0 && !runReadsThreadHistory(run.trigger))
  );
}

/** Background work holds pending steering; paused cards never hold the queue. */
function steersUserMessage(run: { status: string; trigger?: string | null }) {
  return STEERABLE_RUN_STATUSES.has(run.status) && isConversationalRun(run.trigger);
}

/** A run acts with its sender's accounts, so only that person's messages may steer it. */
function steersMessageFrom(
  run: { status: string; trigger?: string | null; userId: string },
  actor: Actor,
) {
  return steersUserMessage(run) && run.userId === actor.userId;
}

type MentionTargetInput = string | { kind: "bot" | "group" | "routine" | "connector"; id: string };

function splitMentionTargets(mentions: MentionTargetInput[] | undefined) {
  const botMentionIds = new Set<string>();
  const groupMentionIds = new Set<string>();
  const routineMentionIds = new Set<string>();
  const connectorMentionIds = new Set<string>();
  for (const mention of mentions ?? []) {
    if (typeof mention === "string") {
      botMentionIds.add(mention);
      continue;
    }
    if (mention.kind === "bot") botMentionIds.add(mention.id);
    if (mention.kind === "group") groupMentionIds.add(mention.id);
    if (mention.kind === "routine") routineMentionIds.add(mention.id);
    if (mention.kind === "connector") connectorMentionIds.add(mention.id);
  }
  return {
    botMentionIds: [...botMentionIds],
    groupMentionIds: [...groupMentionIds],
    routineMentionIds: [...routineMentionIds],
    connectorMentionIds: [...connectorMentionIds],
  };
}

async function resolveOwnedConnectorDisplayNames(
  tx: Prisma.TransactionClient,
  actor: Actor,
  connectionIds: string[],
) {
  if (!connectionIds.length) return [];
  const rows = await tx.connection.findMany({
    where: {
      id: { in: connectionIds },
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "connected",
    },
    select: { id: true, displayName: true },
  });
  if (rows.length !== connectionIds.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row.displayName]));
  return connectionIds.map((id) => byId.get(id) ?? "connector");
}

export function sendRunClientNonce(
  clientNonce: string | undefined,
  messageId: string,
  botId?: string,
): string | undefined {
  if (!clientNonce) return undefined;
  return botId ? `send:${messageId}:${botId}` : `send:${messageId}`;
}

export async function enqueueRunsNeedingContinue(
  jobs: JobPublisher,
  runs: Array<{ id: string; status: string }>,
) {
  await Promise.all(
    runs
      .filter((run) => RUNS_NEEDING_CONTINUE.has(run.status))
      .map((run) =>
        jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          // The queued run is durable; the reconciler repairs a missed immediate wake.
          getLogger().error("thread send enqueue", error);
        }),
      ),
  );
}

async function findSendReceipt(prisma: PrismaClient, threadId: string, clientNonce: string) {
  return prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce } },
    include: { sourceRuns: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

async function replayExistingSend(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  threadId: string,
  clientNonce: string | undefined,
  releaseTakeover?: (runId: string) => Promise<void>,
) {
  if (!clientNonce) return null;
  const message = await findSendReceipt(deps.prisma, threadId, clientNonce);
  if (!message) return null;
  const receiptEvent = await deps.prisma.event.findFirst({
    where: {
      threadId,
      type: "thread.message.created",
      payload: { path: ["messageId"], equals: message.id },
    },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const receiptRunIds = sendEventRunIds(receiptEvent?.payload);
  const receiptRuns = receiptRunIds.length
    ? await deps.prisma.run.findMany({ where: { id: { in: receiptRunIds } } })
    : [];
  const receiptRunById = new Map(receiptRuns.map((run) => [run.id, run]));
  const orderedReceiptRuns = receiptRunIds.flatMap((id) => {
    const run = receiptRunById.get(id);
    return run ? [run] : [];
  });
  const linkedRun =
    message.sourceRuns[0] ??
    (message.runId ? await deps.prisma.run.findUnique({ where: { id: message.runId } }) : null);
  if (!linkedRun && orderedReceiptRuns.length === 0) return null;
  const runs = orderedReceiptRuns.length
    ? orderedReceiptRuns
    : message.sourceRuns.length
      ? message.sourceRuns
      : [linkedRun!];
  const pendingSteering = releaseTakeover
    ? await deps.prisma.steeringMessage.findFirst({
        where: { messageId: message.id, claimedAt: null },
        select: { runId: true },
      })
    : null;
  if (releaseTakeover && pendingSteering?.runId) await releaseTakeover(pendingSteering.runId);
  await enqueueRunsNeedingContinue(deps.jobs, runs);
  const latestEvent = await deps.prisma.event.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (latestEvent) {
    await deps.events.notify(threadId, latestEvent.seq).catch((error) => {
      // Subscribers catch up from the durable event cursor after a missed realtime wake.
      getLogger().error("thread send realtime notification", error);
    });
  }
  return sendResult(message, runs);
}

function sendEventRunIds(payload: Prisma.JsonValue | undefined): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const runIds = (payload as { runIds?: unknown }).runIds;
  return Array.isArray(runIds) ? runIds.filter((id): id is string => typeof id === "string") : [];
}

function sendResult(message: { seq: number }, runs: Array<{ id: string; taskId: string }>) {
  const first = runs[0];
  if (!first) throw new IsolationError("Send did not create a run");
  return {
    taskId: first.taskId,
    runId: first.id,
    seq: message.seq,
    runIds: runs.map((run) => run.id),
  };
}

export async function cancelSupersededQueuedRuns(
  tx: Prisma.TransactionClient,
  input: { threadId: string; botIds: string[]; keepRunIds: string[] },
) {
  const superseded = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: { in: input.botIds },
      status: "queued",
      OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
      id: { notIn: input.keepRunIds },
    },
    select: { id: true, taskId: true },
  });
  if (superseded.length === 0) return;
  const now = new Date();
  await tx.run.updateMany({
    where: { id: { in: superseded.map((run) => run.id) } },
    data: { status: "cancelled", completedAt: now },
  });
  await clearEndedRunState(
    tx,
    superseded.map((run) => run.id),
  );
  await tx.task.updateMany({
    where: { id: { in: superseded.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}

export async function lockAndLoadGroupMembers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: Extract<ThreadTarget, { kind: "group" }>,
) {
  await lockSpaceGroup(tx, actor, target.groupId);
  const group = await tx.chatGroup.findFirst({
    where: {
      id: target.groupId,
      spaceId: actor.spaceId,
      archivedAt: null,
      thread: { id: target.threadId },
    },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: { bot: { select: { id: true, name: true, color: true, avatarSet: true } } },
        orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
      },
    },
  });
  if (!group || group.members.length < GROUP_MEMBER_MIN) throw new IsolationError();
  return group.members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
    avatarSet: resolveBotAvatarSet(member.bot.avatarSet),
  }));
}

/**
 * The members a group send wakes. A message that names nobody and replies to a member's message
 * goes to that member alone; one that names nobody and replies to no member reaches everyone,
 * and `namesNobody` then lets each member stay silent.
 */
function groupSendTargets(
  members: Array<{ botId: string; name: string }>,
  input: { text?: string; mentions?: MentionTargetInput[] },
  replied: string | undefined,
) {
  const targeting = {
    text: input.text ?? "",
    members: members.map((member) => ({ id: member.botId, name: member.name })),
    explicitMentions: splitMentionTargets(input.mentions).botMentionIds,
  };
  const named = mentionedGroupBotIds(targeting).length > 0;
  if (!named && replied && members.some((member) => member.botId === replied)) {
    return { botIds: [replied], namesNobody: false };
  }
  return { botIds: resolveGroupTargetBotIds(targeting), namesNobody: !named };
}

export function latestWaitingRun<T extends { id: string; status: string; updatedAt: Date }>(
  runs: T[],
) {
  const later = (a: T, b: T) =>
    a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id);
  return runs
    .filter((run) => run.status === "waiting_input")
    .reduce<T | undefined>(
      (latest, run) => (!latest || later(run, latest) > 0 ? run : latest),
      undefined,
    );
}

/** The bot whose message a send replies to, if any. */
export async function replyParentBotId(
  prisma: Pick<PrismaClient, "message">,
  target: { threadId: string },
  input: { replyToMessageId?: string },
): Promise<string | undefined> {
  if (!input.replyToMessageId) return undefined;
  const reply = await prisma.message.findFirst({
    where: { id: input.replyToMessageId, threadId: target.threadId, role: "bot" },
    select: { botId: true },
  });
  return reply?.botId ?? undefined;
}

/** The bots a send wakes: the bot itself, or the group members it names (else every member). */
export function sendTargetBotIds(
  target:
    | { kind: "bot"; botId: string }
    | { kind: "group"; members: Array<{ botId: string; name: string }> },
  input: { text?: string; mentions?: MentionTargetInput[] },
  replied?: string,
): string[] {
  if (target.kind === "bot") return [target.botId];
  return groupSendTargets(target.members, input, replied).botIds;
}

export async function resolveThreadTarget(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; groupId?: string },
  options: { includeArchived?: boolean } = {},
): Promise<ThreadTarget> {
  const repos = createRepos(prisma);
  const groupRepos = createGroupRepos(prisma);
  if (input.botId) {
    const bot = await repos.getBot(actor, input.botId, options);
    if (!bot.thread) throw new IsolationError();
    return {
      kind: "bot",
      botId: bot.id,
      threadId: bot.thread.id,
      bot,
    };
  }
  if (input.groupId) {
    const group = await groupRepos.getGroupTarget(actor, input.groupId);
    if (!group.thread) throw new IsolationError();
    const members = group.members.map((member) => ({
      botId: member.bot.id,
      name: member.bot.name,
      color: member.bot.color,
      avatarSet: resolveBotAvatarSet(member.bot.avatarSet),
      status: primaryActiveRun(member.bot.runs)?.status ?? "idle",
    }));
    return {
      kind: "group",
      groupId: group.id,
      threadId: group.thread.id,
      groupName: group.name,
      members,
      memberBotIds: members.map((member) => member.botId),
    };
  }
  throw new IsolationError();
}

export async function threadHead(prisma: PrismaClient, target: ThreadTarget) {
  const latest = await prisma.event.findFirst({
    where: { threadId: target.threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return { threadId: target.threadId, cursor: latest?.seq ?? -1 };
}

/**
 * Admit a confirmed image against the model each recipient run will use: the waiting runs this
 * text answers, otherwise the run that would take it as steering, otherwise the bot's default.
 */
async function assertImageRecipients(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: { threadId: string },
  text: string | undefined,
  attachmentBlocks: MessageBlock[],
  recipient: {
    botId: string;
    runs: Array<ImageAdmissionRun & { id: string; userId: string }>;
    imageAdmission: Parameters<typeof assertThreadImageInput>[5];
  },
) {
  if (!attachmentBlocks.some((block) => block.kind === "image")) return;
  const { botId, runs } = recipient;
  const answered = [];
  for (const run of runs.filter(
    (run) => run.status === "waiting_input" && run.userId === actor.userId,
  )) {
    const eligible = await eligibleWaitingTextAnswer(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      runId: run.id,
      answeredByUserId: actor.userId,
      answer: text ?? "",
    });
    if (eligible) answered.push(run);
  }
  // Another person's run never takes this message: it starts or steers the sender's own run,
  // so only their runs can decide which model the image must suit.
  const own = runs.filter((run) => run.userId === actor.userId);
  const current =
    own.find(steersUserMessage) ?? own.find((run) => STEERABLE_RUN_STATUSES.has(run.status));
  for (const run of answered.length ? answered : [current]) {
    await assertThreadImageInput(
      tx as unknown as PrismaClient,
      actor,
      botId,
      attachmentBlocks,
      run && (isConversationalRun(run.trigger) || run.status === "waiting_input") ? run : undefined,
      recipient.imageAdmission,
    );
  }
}

/** Intent changes the message representation, never the owned artifact. */
function sendAttachmentBlocks(
  blocks: Extract<MessageBlock, { kind: "image" | "file" }>[],
  artifacts: Array<{ id: string; size: number }>,
  handling: "confirm" | "file" | undefined,
): Extract<MessageBlock, { kind: "image" | "file" }>[] {
  return blocks.map((block) => {
    if (block.kind !== "image") return block;
    if (handling === "file")
      return {
        ...block,
        kind: "file",
        size: artifacts.find((artifact) => artifact.id === block.artifactId)!.size,
      };
    return handling === "confirm" ? { ...block, imageHandling: "confirm" } : block;
  });
}

export async function sendThreadMessage(
  deps: {
    prisma: PrismaClient;
    events: ThreadEvents;
    jobs: JobPublisher;
    imageAdmission?: Parameters<typeof assertThreadImageInput>[5];
    maxAttachmentsPerMessage?: number;
    analytics?: ProductAnalytics;
    sandbox: SandboxProvider;
    notifications?: NotificationProvider;
  },
  actor: Actor,
  target: ThreadTarget,
  input: {
    text?: string;
    artifactIds?: string[];
    imageHandling?: "confirm" | "file";
    mentions?: MentionTargetInput[];
    replyToMessageId?: string;
    replyQuote?: string;
    fromPage?: true;
    clientNonce?: string;
    /** No model to start a turn: the send may only stop active work. */
    noModel?: boolean;
  },
  releaseTakeover?: (runId: string) => Promise<void>,
  /** Runs saved with the message, after the thread lock and before the message is routed. */
  startRoutines?: (tx: Prisma.TransactionClient) => Promise<Array<{ id: string; status: string }>>,
) {
  const existing = await replayExistingSend(
    deps,
    target.threadId,
    input.clientNonce,
    releaseTakeover,
  );
  if (existing) return existing;
  // Live events carry the call id so a spoken turn joins the call card on first
  // paint; without it the bubble shows loose until a refetch reads the nonce.
  const callId = callIdFromClientNonce(input.clientNonce);
  const requestedReplyQuote = input.replyQuote?.trim() || undefined;
  if (requestedReplyQuote && !input.replyToMessageId) {
    throw new ORPCError("BAD_REQUEST", { message: "replyQuote requires replyToMessageId." });
  }

  const commit = () =>
    deps.prisma.$transaction(async (tx) => {
      // A Space being deleted takes no new turns; its lock comes before the group and thread rows.
      if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
      const author = await loadMessageAuthor(tx, actor.userId);
      let routineRuns: Array<{ id: string; status: string }> = [];
      let replyToMessageId: string | undefined;
      let replyQuote: string | undefined;
      let replyPreview: ReplyPreview | null | undefined;
      let repliedBotId: string | undefined;
      let repliedQuestionRunId: string | undefined;
      if (input.replyToMessageId) {
        const reply = await tx.message.findFirst({
          where: { id: input.replyToMessageId, threadId: target.threadId },
          select: {
            id: true,
            blocks: true,
            role: true,
            botId: true,
            authorUserId: true,
            runId: true,
          },
        });
        // A missing target must not lose the send or retain an unverified id.
        // The empty server-owned quote preserves the unavailable state after reload.
        if (!reply) {
          replyQuote = "";
          replyPreview = null;
        } else {
          replyToMessageId = input.replyToMessageId;
          if (reply.role === "bot" && reply.botId) repliedBotId = reply.botId;
          const parsed = MessageBlockSchema.array().safeParse(reply.blocks);
          replyPreview = null;
          if (parsed.success) {
            if (
              reply.role === "bot" &&
              parsed.data.some(
                (block) =>
                  block.kind === "ask" && isQuestionAskBlock(block) && block.status !== "answered",
              )
            ) {
              repliedQuestionRunId = reply.runId ?? undefined;
            }
            replyPreview = messageReplyPreview(
              parsed.data,
              reply.role as ReplyPreview["role"],
              reply.botId ?? undefined,
              await loadMessageAuthor(tx, reply.authorUserId),
            );
            // Attachment labels stay in the preview; only selected text is persisted as a quote.
            if (
              !requestedReplyQuote &&
              !replyPreview.attachment &&
              !(input.fromPage && replyPreview.page)
            ) {
              replyQuote = replyPreview.text || undefined;
            }
          }
          // Persist only text derived from the authoritative parent. A
          // mismatch or a derivation failure still sends a plain reply so
          // quote verification cannot lose a message.
          if (requestedReplyQuote && parsed.success) {
            try {
              replyQuote = deriveMessageQuote(
                parsed.data,
                requestedReplyQuote,
                reply.role === "user" ? "plain-text" : "markdown",
              );
            } catch (error) {
              getLogger().error("thread send quote derivation", error);
              replyQuote = undefined;
            }
          }
        }
      }

      const composerAnswerInput = (message: { id: string; seq: number }) => ({
        spaceId: actor.spaceId,
        threadId: target.threadId,
        answeredByUserId: actor.userId,
        answer: input.text ?? "",
        beforeMessageSeq: message.seq,
        ...(replyToMessageId ? { replyToMessageId } : {}),
        answerMessageId: message.id,
      });
      const targetedQuestionRun = (
        runs: readonly { id: string; status: string; userId: string }[],
      ) =>
        runs.find(
          (run) =>
            run.id === repliedQuestionRunId &&
            run.status === "waiting_input" &&
            run.userId === actor.userId,
        )?.id;

      if (target.kind === "bot") {
        const mentionTargets = splitMentionTargets(input.mentions);
        const { blocks: attachmentBlocks, artifacts } = await resolveSendAttachments(
          { prisma: tx, maxAttachmentsPerMessage: deps.maxAttachmentsPerMessage },
          actor,
          target.botId,
          input.artifactIds,
        );
        const connectorNames = await resolveOwnedConnectorDisplayNames(
          tx,
          actor,
          mentionTargets.connectorMentionIds,
        );
        // Match message counter locking before inspecting runs, without changing counters on rejection.
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
        routineRuns = (await startRoutines?.(tx)) ?? [];
        const activeRuns = await tx.run.findMany({
          where: {
            threadId: target.threadId,
            botId: target.botId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
          },
          select: {
            id: true,
            taskId: true,
            status: true,
            trigger: true,
            userId: true,
            modelProvider: true,
            modelId: true,
            modelPinned: true,
            thinkingLevel: true,
          },
        });
        if (input.imageHandling === "confirm") {
          await assertImageRecipients(tx, actor, target, input.text, attachmentBlocks, {
            botId: target.botId,
            runs: activeRuns,
            imageAdmission: deps.imageAdmission,
          });
        }
        const blocks = buildUserMessageBlocks(
          input.text,
          sendAttachmentBlocks(attachmentBlocks, artifacts, input.imageHandling),
        );
        const message = await createThreadMessageInTransaction(tx, {
          threadId: target.threadId,
          role: "user",
          authorUserId: actor.userId,
          blocks,
          replyToMessageId,
          replyQuote,
          clientNonce: input.clientNonce,
        });
        // A bare "stop" from the owner while work is active is the Stop button, not a reply.
        const stopping = activeRuns.length > 0 && !routineRuns.length && isStopMessage(input);
        if (input.noModel && !stopping) {
          throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
        }
        const answered: typeof activeRuns = [];
        const targetedRunId = targetedQuestionRun(activeRuns);
        // Someone else's question stays on its card; this message starts the sender's own run.
        for (const run of activeRuns.filter(
          (run) => !stopping && run.status === "waiting_input" && run.userId === actor.userId,
        )) {
          if (targetedRunId && run.id !== targetedRunId) continue;
          if (
            await answerWaitingRunWithTextInTransaction(tx, {
              ...composerAnswerInput(message),
              runId: run.id,
            })
          )
            answered.push({ ...run, status: "queued" });
          else
            await retireWaitingQuestionInTransaction(tx, {
              ...composerAnswerInput(message),
              botId: target.botId,
              runId: run.id,
            });
        }
        if (answered.length) {
          const primary = answered[0];
          if (!primary) throw new IsolationError();
          await tx.message.update({ where: { id: message.id }, data: { runId: primary.id } });
          const steered = answered.filter((run) =>
            answerSteersRun(run, attachmentBlocks, input.imageHandling),
          );
          for (const run of steered) {
            await tx.steeringMessage.create({
              data: {
                messageId: message.id,
                botId: target.botId,
                userId: actor.userId,
                runId: run.id,
              },
            });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            type: "thread.message.created",
            runId: primary.id,
            payload: {
              messageId: message.id,
              seq: message.seq,
              role: "user",
              blocks,
              author,
              callId,
              runIds: answered.map((run) => run.id),
              replyToMessageId,
              replyQuote,
              replyPreview,
            },
          });
          return { message, runs: answered, routineRuns, eventSeq: event.seq };
        }
        const holdingRuns = stopping
          ? activeRuns
          : activeRuns.filter(
              (run) =>
                QUEUE_HOLDING_RUN_STATUSES.some((status) => status === run.status) &&
                !messageBypassesTakeoverWait(run),
            );
        const active =
          holdingRuns.find((run) => steersMessageFrom(run, actor)) ??
          holdingRuns.find(steersUserMessage) ??
          holdingRuns[0];
        if (active) {
          // Another person's message waits for a run of its own, which acts with their accounts,
          // and is never shown as part of theirs.
          const ownRunId = active.userId === actor.userId ? active.id : null;
          await tx.steeringMessage.create({
            data: {
              messageId: message.id,
              botId: target.botId,
              userId: actor.userId,
              runId: steersMessageFrom(active, actor) ? active.id : null,
            },
          });
          if (ownRunId) {
            await tx.message.update({ where: { id: message.id }, data: { runId: ownRunId } });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            type: "thread.message.created",
            runId: ownRunId ?? undefined,
            payload: {
              messageId: message.id,
              seq: message.seq,
              role: "user",
              blocks,
              author,
              callId,
              replyToMessageId,
              replyQuote,
              replyPreview,
            },
          });
          if (stopping) {
            const stop = await cancelThreadRuns(actor, target, { botId: target.botId })(tx);
            return { message, runs: [active], routineRuns, eventSeq: event.seq, stop };
          }
          return { message, runs: [active], routineRuns, eventSeq: event.seq };
        }
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            botId: target.botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
            botId: target.botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "user",
            clientNonce: sendRunClientNonce(input.clientNonce, message.id),
            sourceMessageId: message.id,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        await cancelSupersededQueuedRuns(tx, {
          threadId: target.threadId,
          botIds: [target.botId],
          keepRunIds: [run.id],
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          botId: target.botId,
          type: "thread.message.created",
          runId: run.id,
          payload: {
            messageId: message.id,
            seq: message.seq,
            role: "user",
            blocks,
            author,
            callId,
            runIds: [run.id],
            replyToMessageId,
            replyQuote,
            replyPreview,
          },
        });
        return { message, runs: [run], routineRuns, eventSeq: event.seq };
      }

      const members = await lockAndLoadGroupMembers(tx, actor, target);
      const memberBotIds = members.map((member) => member.botId);
      const mentionTargets = splitMentionTargets(input.mentions);
      let { botIds: targetBotIds, namesNobody } = groupSendTargets(members, input, repliedBotId);
      const { blocks: attachmentBlocks, artifacts } = await resolveGroupSendAttachments(
        { prisma: tx, maxAttachmentsPerMessage: deps.maxAttachmentsPerMessage },
        actor,
        target.groupId,
        memberBotIds,
        input.artifactIds,
      );
      const connectorNames = await resolveOwnedConnectorDisplayNames(
        tx,
        actor,
        mentionTargets.connectorMentionIds,
      );
      // Group ownership is locked first, then the thread, as in the normal write path.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
      routineRuns = (await startRoutines?.(tx)) ?? [];
      let activeRuns = await tx.run.findMany({
        where: {
          threadId: target.threadId,
          botId: { in: targetBotIds },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: {
          id: true,
          taskId: true,
          botId: true,
          status: true,
          trigger: true,
          userId: true,
          modelProvider: true,
          modelId: true,
          modelPinned: true,
          thinkingLevel: true,
          updatedAt: true,
        },
      });
      // A plain message while members wait on the user answers the latest question only.
      const asking = namesNobody ? latestWaitingRun(activeRuns) : undefined;
      if (asking) {
        targetBotIds = [asking.botId];
        namesNobody = false;
        activeRuns = activeRuns.filter((run) => run.botId === asking.botId);
      }
      if (input.imageHandling === "confirm") {
        for (const botId of targetBotIds) {
          await assertImageRecipients(tx, actor, target, input.text, attachmentBlocks, {
            botId,
            runs: activeRuns.filter((run) => run.botId === botId),
            imageAdmission: deps.imageAdmission,
          });
        }
      }
      const blocks = buildUserMessageBlocks(
        input.text,
        sendAttachmentBlocks(attachmentBlocks, artifacts, input.imageHandling),
      );
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        authorUserId: actor.userId,
        blocks,
        replyToMessageId,
        replyQuote,
        clientNonce: input.clientNonce,
      });
      // A bare "stop" while any member, or a helper it started, works is the Stop button,
      // as in a bot's own chat.
      const working =
        !routineRuns.length && isStopMessage(input)
          ? await tx.run.findFirst({
              where: {
                OR: [
                  { threadId: target.threadId, botId: { in: memberBotIds } },
                  {
                    trigger: BACKGROUND_HELPER_TRIGGER,
                    sourceMessage: { threadId: target.threadId },
                  },
                ],
                status: { in: [...ACTIVE_RUN_STATUSES] },
              },
              select: { id: true, taskId: true, botId: true, status: true, userId: true },
            })
          : null;
      if (working) {
        await touchGroupUpdatedAt(tx, target.groupId);
        const event = await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          botId: working.botId,
          type: "thread.message.created",
          payload: {
            messageId: message.id,
            seq: message.seq,
            role: "user",
            blocks,
            author,
            callId,
            // The stopped run is the receipt a retry of this send replays.
            runIds: [working.id],
            replyToMessageId,
            replyQuote,
            replyPreview,
          },
        });
        // Steering is cleared for the members locked above, not the earlier snapshot.
        const stop = await cancelThreadRuns(
          actor,
          { ...target, memberBotIds },
          { botId: working.botId },
        )(tx);
        return { message, runs: [working], routineRuns, eventSeq: event.seq, stop };
      }
      if (input.noModel) {
        throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
      }
      const activeByBotId = new Map<string, (typeof activeRuns)[number]>();
      const rank = (candidate: (typeof activeRuns)[number]) =>
        steersMessageFrom(candidate, actor) ? 2 : steersUserMessage(candidate) ? 1 : 0;
      const answeredByBotId = new Map<string, Array<(typeof activeRuns)[number]>>();
      const targetedRunId = targetedQuestionRun(activeRuns);
      for (const run of activeRuns) {
        if (run.status === "waiting_input") {
          // Someone else's question stays on its card; this message starts the sender's own run.
          if (run.userId !== actor.userId || (targetedRunId && run.id !== targetedRunId)) continue;
          const answered = await answerWaitingRunWithTextInTransaction(tx, {
            ...composerAnswerInput(message),
            runId: run.id,
          });
          if (answered) {
            const queuedForBot = answeredByBotId.get(run.botId) ?? [];
            queuedForBot.push({ ...run, status: "queued" });
            answeredByBotId.set(run.botId, queuedForBot);
          } else {
            await retireWaitingQuestionInTransaction(tx, {
              ...composerAnswerInput(message),
              botId: run.botId,
              runId: run.id,
            });
          }
          continue;
        }
        if (!STEERABLE_RUN_STATUSES.has(run.status) || messageBypassesTakeoverWait(run)) continue;
        const current = activeByBotId.get(run.botId);
        if (!current || rank(run) > rank(current)) activeByBotId.set(run.botId, run);
      }
      const runs: Array<{
        id: string;
        taskId: string;
        botId: string;
        status: string;
        userId: string;
        trigger?: string | null;
      }> = [];
      for (const botId of targetBotIds) {
        const answered = answeredByBotId.get(botId);
        if (answered) {
          const steered = answered.filter((run) =>
            answerSteersRun(run, attachmentBlocks, input.imageHandling),
          );
          for (const run of steered) {
            await tx.steeringMessage.create({
              data: { messageId: message.id, botId, userId: actor.userId, runId: run.id },
            });
          }
          // A person who answered the member's question is talking to it.
          await tx.run.updateMany({
            where: { id: { in: answered.map((run) => run.id) } },
            data: { groupReplyOptional: false },
          });
          runs.push(...answered);
          continue;
        }
        const active = activeByBotId.get(botId);
        if (active) {
          // Naming a member that is still working on an unnamed message makes its reply required.
          if (!namesNobody && steersUserMessage(active)) {
            await tx.run.update({ where: { id: active.id }, data: { groupReplyOptional: false } });
          }
          await tx.steeringMessage.create({
            data: {
              messageId: message.id,
              botId,
              userId: actor.userId,
              runId: steersMessageFrom(active, actor) ? active.id : null,
            },
          });
          runs.push(active);
          continue;
        }
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "user",
            groupReplyOptional: namesNobody,
            clientNonce: sendRunClientNonce(input.clientNonce, message.id, botId),
            sourceMessageId: message.id,
          },
        });
        runs.push(run);
      }
      const firstRun = runs[0];
      // The message belongs to a run of the sender's, never to one another member started.
      const ownRun = runs.find((run) => run.userId === actor.userId);
      // The event names the bot of the run it carries, so clients pair them correctly.
      const eventBotId = ownRun?.botId ?? firstRun?.botId ?? targetBotIds[0];
      if (!eventBotId) throw new IsolationError("Group send did not resolve a target");
      if (firstRun) {
        if (ownRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: ownRun.id } });
        }
        const createdRuns = runs.filter(
          (run) => !activeByBotId.has(run.botId) && !answeredByBotId.has(run.botId),
        );
        if (createdRuns.length) {
          await cancelSupersededQueuedRuns(tx, {
            threadId: target.threadId,
            botIds: createdRuns.map((run) => run.botId),
            keepRunIds: createdRuns.map((run) => run.id),
          });
        }
      }
      await touchGroupUpdatedAt(tx, target.groupId);
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: eventBotId,
        type: "thread.message.created",
        runId: firstRun ? ownRun?.id : activeRuns[0]?.id,
        payload: {
          messageId: message.id,
          seq: message.seq,
          role: "user",
          blocks,
          author,
          callId,
          runIds: runs.map((run) => run.id),
          replyToMessageId,
          replyQuote,
          replyPreview,
        },
      });
      return { message, runs, routineRuns, eventSeq: event.seq };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);

  const committed = await withTransactionRetry(commit).catch(async (error) => {
    const winner = await replayExistingSend(
      deps,
      target.threadId,
      input.clientNonce,
      releaseTakeover,
    );
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  deps.analytics?.capture(
    actor.userId,
    { name: "message_sent", trigger: "user" },
    { id: committed.message.id, at: committed.message.createdAt },
  );
  if ("stop" in committed && committed.stop) {
    await finishThreadStop(deps, actor, target, committed.stop);
    return sendResult(committed.message, committed.runs);
  }
  await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
    // Subscribers catch up from the durable event cursor after a missed realtime wake.
    getLogger().error("thread send realtime notification", error);
  });
  if (
    memberMessageAlerts({
      callId,
      blocks: committed.message.blocks,
      replyToMessageId: committed.message.replyToMessageId,
    })
  ) {
    // Not awaited: the sender's reply does not wait on anyone else's devices.
    void notifyMemberMessage(deps, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      authorUserId: actor.userId,
      text: input.text?.trim() ?? "",
    }).catch((error) => getLogger().error("member message notification", error));
  }
  if (releaseTakeover) {
    for (const run of committed.runs) {
      if (steersMessageFrom(run, actor)) await releaseTakeover(run.id);
    }
  }
  await enqueueRunsNeedingContinue(deps.jobs, [...committed.routineRuns, ...committed.runs]);
  return sendResult(committed.message, committed.runs);
}
