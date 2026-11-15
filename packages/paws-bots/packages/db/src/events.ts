import type { ProductAnalytics, RealtimeFanout } from "@rakazo/adapter-kit";
import type { ChatAlert, MessageBlock, ProductEvent } from "@rakazo/contracts";
import {
  AnalyticsTrigger,
  hasThinkingActivityMarker,
  STEP_SCREENSHOT_MIME_TYPES,
  ThreadActivityPayloadSchema,
} from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  callIdFromClientNonce,
  isConversationalRun,
  messageBypassesTakeoverWait,
  messageSteersRun,
  messagingChannelId,
  normalizeRunError,
  QUEUE_HOLDING_RUN_STATUSES,
  sanitizeJsonValue,
  splitToolHistory,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { createChatAlerts } from "./chat-alerts.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { contentEncryptionOf } from "./content-encryption.js";
import {
  CrossSpaceCommunicationBlockedError,
  crossSpaceCommunicationAllowed,
} from "./cross-space-communication.js";
import {
  followIncomingCallSignals,
  followThreadEvents,
  mapProductEvent,
  notifyCommittedEvent,
  notifyRealtime,
} from "./event-stream.js";
import type { RunLease } from "./messages.js";
import {
  assertRunCanWriteHistory,
  assertRunIsCancelled,
  createThreadMessageInTransaction,
  loadMessageAuthor,
  partialReplyClientNonce,
  RunHistoryWriteError,
} from "./messages.js";
import { isRecordNotFound } from "./prisma-errors.js";
import type { RosterChange } from "./roster-changes.js";
import { followRosterChanges, loadRosterScope, publishRosterChange } from "./roster-changes.js";
import { createRowId } from "./row-id.js";
import { deleteRunSecretsInTransaction } from "./run-secrets.js";
import { isRunResponse, readRunTimingFields } from "./run-timing.js";
import { RUN_TURN_CHECKPOINT_KIND } from "./run-turn-checkpoint.js";
import { SpaceDeletionInProgressError, spaceTakesWork } from "./spaces.js";
import { draftRecordingsOfLease } from "./teaching-recordings.js";
import type { AnswerRunInput, PauseRunForInput, RunSecretWriter } from "./thread-ask.js";
import { answerRunInput, pauseRunForInput } from "./thread-ask.js";
import { clearThreadReads } from "./thread-reads.js";
import type { ClaimedSteeringMessage, ClaimSteeringInput } from "./thread-steering.js";
import {
  claimSteering,
  createPendingSteeringRun,
  discardAnsweredSteering,
  hasChannelMessage,
} from "./thread-steering.js";
import type {
  AnswerTakeoverRequestInput,
  PauseRunForTakeover,
  ReleaseUserControlInput,
} from "./thread-takeover.js";
import {
  answerTakeoverRequest,
  pauseRunForTakeover,
  releaseUserControl,
} from "./thread-takeover.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

export { THREAD_LOCK_TRANSACTION_OPTIONS };

export interface AppendEventInput {
  spaceId: string;
  threadId: string;
  botId: string;
  type: ProductEvent["type"];
  payload: Record<string, unknown>;
  runId?: string;
  /** Terminal echo after the run is already cancelled. Every other event stays rejected. */
  allowCancelledRun?: boolean;
  /** The executing attempt's lease; a superseded attempt cannot write. Never serialized. */
  lease?: RunLease;
}

/** Exact transient lifecycle payloads only: unrelated thread metadata must survive. */
export function transientRunEventsWhere(): Prisma.EventWhereInput {
  return {
    OR: [
      { type: "thread.progress" },
      { type: "thread.meta", payload: { equals: { activity: { thinking: true } } } },
      { type: "thread.meta", payload: { equals: { activity: { thinking: false } } } },
    ],
  };
}

export interface ThreadEvents {
  notifyIncomingCalls?(userId: string): Promise<void>;
  followIncomingCalls?(userId: string, signal?: AbortSignal): AsyncGenerator<void>;
  publishChatAlert?(userId: string, alert: ChatAlert): Promise<void>;
  followChatAlerts?(
    userId: string,
    spaceId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatAlert>;
  publishRosterChange?(change: RosterChange): Promise<void>;
  followRosterChanges?(userId: string, signal?: AbortSignal): AsyncGenerator<void>;
  answerRunInput(input: AnswerRunInput): Promise<boolean>;
  append(input: AppendEventInput): Promise<ProductEvent>;
  claimSteering(input: ClaimSteeringInput): Promise<ClaimedSteeringMessage[]>;
  clearThread(input: ClearThreadInput): Promise<ClearThreadResult>;
  answerTakeoverRequest(input: AnswerTakeoverRequestInput): Promise<boolean>;
  draftRecordingsOfLease(input: { spaceId: string; leaseId: string }): Promise<string[]>;
  finalizeRun(input: FinalizeRunInput): Promise<FinalizeRunResult | false>;
  releaseUserControl(input: ReleaseUserControlInput): Promise<boolean>;
  notify(threadId: string, seq: number, firstResponseRunId?: string): Promise<void>;
  pauseRunForInput(input: PauseRunForInput): Promise<FinalizeRunResult | false>;
  pauseRunForTakeover(input: PauseRunForTakeover): Promise<boolean | { continuationRunId: string }>;
  sendUserMessage(input: SendUserMessageInput): Promise<SendUserMessageResult>;
  follow(threadId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<ProductEvent>;
}

export interface ClearThreadInput {
  spaceId: string;
  threadId: string;
  /** Event author and the bot-scoped target for one-to-one chats. */
  botId: string;
  groupId?: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  /** Stored files of the cleared replies' kept screenshots, for the caller to remove. */
  removedStorageKeys: string[];
  historyCompactionGeneration: number;
}

export interface FinalizeRunResult {
  continuationRunId: string | null;
}

interface FinalizeRunBase {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
}

export type FinalizeRunInput = FinalizeRunBase &
  (
    | {
        outcome: "completed";
        /** Steps may carry their tool and kept calls; they are stored apart from the blocks. */
        blocks: MessageBlock[];
        markUnread?: boolean;
      }
    | {
        outcome: "failed";
        error: string;
        /** Reply text the user saw streaming before the failure, kept as a bot message. */
        partialReply?: MessageBlock[];
      }
  );

export interface SendUserMessageInput {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  /** The person who wrote the message; omitted when the sender is not a known user. */
  authorUserId?: string;
  blocks: MessageBlock[];
  prompt: string;
  trigger: "user" | "follow_up" | "webhook" | "messaging";
  clientNonce?: string;
  linkMessageToRun?: boolean;
  /** Internal bot sender: enforce both bots' cross-space policy in the write transaction. */
  crossSpaceSenderBotId?: string;
  /** When false, persist the user message without starting a run (team-chat transcript). */
  createRun?: boolean;
  /** When true, start a new run even if the bot is already busy (team-chat delivery). */
  allowParallelRun?: boolean;
  /** Model every routine in an inbound delivery agreed on. */
  modelPin?: {
    modelProvider: string;
    modelId: string;
    thinkingLevel: string | null;
  };
  /**
   * Runs in the send's transaction once its message and run exist. Returning false rolls the
   * send back with SendClaimLostError, so a row the caller owns decides between two sends that
   * must not both happen. A replayed send has already passed its claim and skips it.
   */
  claim?: (
    tx: Prisma.TransactionClient,
    sent: { messageId: string; runId: string | null },
  ) => Promise<boolean>;
}

/** A send's claim was lost: another path already owns what it would have started. */
export class SendClaimLostError extends Error {
  override readonly name = "SendClaimLostError";
  constructor() {
    super("Another delivery already owns this message");
  }
}

export interface SendUserMessageResult {
  messageId: string;
  seq: number;
  taskId: string | null;
  runId: string | null;
}

export function createThreadEvents(
  prisma: PrismaClient,
  realtime?: RealtimeFanout,
  options: {
    catchUpMs?: number;
    runSecretWriter?: RunSecretWriter;
    analytics?: ProductAnalytics;
  } = {},
): ThreadEvents {
  const chatAlerts = createChatAlerts(realtime);
  return {
    publishChatAlert: chatAlerts.publish,
    followChatAlerts: chatAlerts.follow,
    notifyIncomingCalls: async (userId) => {
      await realtime?.publish(`incoming-calls:${userId}`, "");
    },
    followIncomingCalls: (userId, signal) => followIncomingCallSignals(realtime, userId, signal),
    publishRosterChange: (change) => publishRosterChange(realtime, change),
    ...(realtime && {
      followRosterChanges: (userId, signal) =>
        followRosterChanges(realtime, userId, () => loadRosterScope(prisma, userId), signal),
    }),
    answerRunInput: (input) => answerRunInput(prisma, input, realtime, options.runSecretWriter),
    append: (input) => appendEvent(prisma, input, realtime, options.analytics),
    claimSteering: (input) => claimSteering(prisma, input),
    clearThread: (input) => clearThread(prisma, input, realtime),
    answerTakeoverRequest: (input) => answerTakeoverRequest(prisma, input, realtime),
    draftRecordingsOfLease: (input) => draftRecordingsOfLease(prisma, input, realtime),
    releaseUserControl: (input) => releaseUserControl(prisma, input, realtime),
    finalizeRun: (input) => finalizeRun(prisma, input, realtime, options.analytics),
    notify: (threadId, seq, firstResponseRunId) =>
      notifyCommittedEvent(prisma, realtime, threadId, seq, firstResponseRunId),
    pauseRunForInput: (input) => pauseRunForInput(prisma, input, realtime),
    pauseRunForTakeover: (input) => pauseRunForTakeover(prisma, input, realtime),
    sendUserMessage: (input) => sendUserMessage(prisma, input, realtime, options.analytics),
    follow: (threadId, cursor, signal) =>
      followThreadEvents(prisma, threadId, cursor, realtime, signal, options.catchUpMs),
  };
}

export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
  realtime?: RealtimeFanout,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Group before thread, the order every group writer uses (see lockOwnedGroup).
    if (input.groupId) {
      await tx.$queryRaw`
        SELECT id FROM chat_groups
        WHERE id = ${input.groupId} AND "spaceId" = ${input.spaceId}
        FOR NO KEY UPDATE`;
    }
    const thread = await tx.thread.update({
      where: {
        id: input.threadId,
        spaceId: input.spaceId,
        ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId }),
      },
      // Takes the thread's row lock, as every message writer does; nothing in it changes.
      data: { nextMessageSeq: { increment: 0 } },
      select: { nextMessageSeq: true, historyCompactionGeneration: true, userId: true },
    });
    await clearThreadReads(tx, input.threadId);
    const activeRuns = await tx.run.findMany({
      where: {
        spaceId: input.spaceId,
        ...(input.groupId
          ? { threadId: input.threadId }
          : {
              OR: [
                { threadId: input.threadId, botId: input.botId },
                // Background helpers this chat started work in threads of their own.
                { trigger: BACKGROUND_HELPER_TRIGGER, sourceMessage: { threadId: input.threadId } },
              ],
            }),
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { id: true, taskId: true, userId: true, spaceId: true },
    });
    const now = new Date();
    const runIds = (await cancelRunsInTransaction(tx, activeRuns, now)).map((run) => run.id);
    // Expire as tombstones so a still-open provider screen claim cannot reset fencing to 1.
    await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
    // Helpers start only from the bot's own chat, so every thread the bot's helpers wrote goes
    // with it, including imported ones that have no runs.
    const helperThreads = { spaceId: input.spaceId, helperBotId: input.botId };
    const cleared = input.groupId
      ? { threadId: input.threadId }
      : { OR: [{ threadId: input.threadId }, { thread: helperThreads }] };
    // A reply's kept screenshots belong to its messages, so they go with them.
    const clearedRuns = await tx.message.findMany({
      where: { ...cleared, runId: { not: null } },
      select: { runId: true },
      distinct: ["runId"],
    });
    const screenshots = await tx.artifact.findMany({
      where: {
        spaceId: input.spaceId,
        mimeType: { in: STEP_SCREENSHOT_MIME_TYPES },
        runId: { in: clearedRuns.flatMap((message) => (message.runId ? [message.runId] : [])) },
      },
      select: { id: true, storageKey: true },
    });
    if (screenshots.length > 0)
      await tx.artifact.deleteMany({ where: { id: { in: screenshots.map((row) => row.id) } } });
    await tx.message.deleteMany({ where: cleared });
    await tx.event.deleteMany({ where: cleared });
    if (!input.groupId) {
      await tx.thread.updateMany({
        where: { ...helperThreads, historyCompactionSummary: { not: null } },
        data: { historyCompactionSummary: null, historyCompactionGeneration: { increment: 1 } },
      });
    }
    if (thread.nextMessageSeq > 0) {
      // nextMessageSeq is not reset, so mark every deleted message as already compacted.
      // Leaving the cursor behind would let compaction re-summarize deleted history (or, reset
      // to null, immediately re-fire on the fresh conversation).
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactedUpToSeq: thread.nextMessageSeq - 1,
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    } else {
      await tx.thread.update({
        where: { id: input.threadId },
        data: {
          historyCompactionSummary: null,
          historyCompactionGeneration: { increment: 1 },
        },
      });
    }
    if (input.groupId) {
      await tx.chatGroup.update({ where: { id: input.groupId }, data: { updatedAt: now } });
    } else {
      await tx.bot.update({
        where: { id: input.botId, spaceId: input.spaceId },
        data: { updatedAt: now },
      });
    }
    const event = await appendEventInTransaction(tx, {
      ...input,
      type: "thread.cleared",
      payload: {},
    });
    return {
      event,
      userId: thread.userId,
      cancelledRunIds: runIds,
      historyCompactionGeneration: thread.historyCompactionGeneration,
      removedStorageKeys: screenshots.map((row) => row.storageKey),
    };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await notifyRealtime(realtime, committed.event.threadId, committed.event.seq);
  if (!input.groupId && committed.userId)
    await realtime?.publish(`incoming-calls:${committed.userId}`, "").catch(() => undefined);
  // Legacy execution bindings point at runs of pre-lease releases, which kept writing
  // Computer.executionRunId. Clearing them inside the transaction reaches for the
  // computer row while holding the thread row. This statement holds no other row, so it can
  // wait out any holder.
  // The clear is already committed: a failed sweep leaves a stale binding for the idle pass
  // to clear, and must not report the clear itself as failed.
  if (committed.cancelledRunIds.length > 0) {
    await withTransactionRetry(() =>
      prisma.computer.updateMany({
        where: { executionRunId: { in: committed.cancelledRunIds } },
        data: {
          executionRunId: null,
          executionBotId: null,
          executionLeaseExpiresAt: null,
        },
      }),
    ).catch((error: unknown) => {
      getLogger().error("legacy computer binding sweep after thread clear", error);
    });
  }
  return {
    event: mapProductEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    historyCompactionGeneration: committed.historyCompactionGeneration,
    removedStorageKeys: committed.removedStorageKeys,
  };
}

export async function sendUserMessage(
  prisma: PrismaClient,
  input: SendUserMessageInput,
  realtime?: RealtimeFanout,
  analytics?: ProductAnalytics,
): Promise<SendUserMessageResult> {
  const replay = async (): Promise<SendUserMessageResult | null> => {
    if (!input.clientNonce) return null;
    const message = await prisma.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: input.clientNonce,
        },
      },
    });
    if (!message) return null;
    const created = await prisma.run.findFirst({
      where: { sourceMessageId: message.id },
      orderBy: { createdAt: "asc" },
    });
    const run =
      created ??
      (message.runId ? await prisma.run.findUnique({ where: { id: message.runId } }) : null);
    return {
      messageId: message.id,
      seq: message.seq,
      taskId: created?.taskId ?? null,
      runId: run?.id ?? null,
    };
  };
  const existing = await replay();
  if (existing) return existing;

  const commit = () =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Webhooks, texts and other bots can reach a Space until its teardown finishes; one being
      // deleted takes no new turns. A transcript copy that starts none is still kept.
      if (input.createRun !== false && !(await spaceTakesWork(tx, input.spaceId)))
        throw new SpaceDeletionInProgressError();
      // Message first: its thread-row lock serializes the whole send against clearThread, so a
      // concurrent clear either sees the committed run and cancels it, or strictly precedes this
      // transaction. Created in separate transactions, the run could land inside the clear's
      // window and later repopulate the cleared conversation, and a clear could strand the
      // message without its event.
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "user",
        blocks: input.blocks,
        authorUserId: input.authorUserId,
        clientNonce: input.clientNonce,
      });
      if (
        input.crossSpaceSenderBotId &&
        !(await crossSpaceCommunicationAllowed(tx, input.crossSpaceSenderBotId, input.botId))
      ) {
        throw new CrossSpaceCommunicationBlockedError();
      }
      const author = await loadMessageAuthor(tx, input.authorUserId);
      const createRun = input.createRun !== false;
      // Include the creation intro. It has no tools, so it must not absorb the message, and a
      // second run would overlap it on a dedicated computer. Pending steering waits for the
      // continuation that starts when the intro finishes.
      const activeRuns =
        createRun && !input.allowParallelRun
          ? await tx.run.findMany({
              where: {
                threadId: input.threadId,
                botId: input.botId,
                status: {
                  in: [...QUEUE_HOLDING_RUN_STATUSES],
                },
              },
              select: {
                id: true,
                taskId: true,
                trigger: true,
                status: true,
                userId: true,
                sourceMessage: { select: { blocks: true } },
              },
            })
          : [];
      // A group text never ends the owner's paused app task: it waits for it like any other turn.
      const fromGroup = hasChannelMessage(input.blocks);
      const channelId = messagingChannelId(input.blocks);
      // A run acts with its sender's accounts, so another person's message waits for a run of
      // their own.
      const steersRun = (run: (typeof activeRuns)[number]) =>
        run.userId === input.userId &&
        messageSteersRun(
          input.trigger,
          run.trigger,
          channelId,
          messagingChannelId(run.sourceMessage?.blocks as MessageBlock[] | undefined),
        );
      const holdingRuns = activeRuns.filter(
        (run) => !messageBypassesTakeoverWait(run, fromGroup || steersRun(run)),
      );
      // Prefer a run that can take this message, then preserve the conversational queue fallback.
      const busy =
        holdingRuns.find(steersRun) ??
        holdingRuns.find((run) => isConversationalRun(run.trigger)) ??
        holdingRuns[0] ??
        null;
      let task = null;
      let run = null;
      if (createRun && !busy) {
        task = await tx.task.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            prompt: input.prompt,
            status: "queued",
          },
        });
        run = await tx.run.create({
          data: {
            spaceId: input.spaceId,
            botId: input.botId,
            threadId: input.threadId,
            taskId: task.id,
            userId: input.userId,
            status: "queued",
            trigger: input.trigger,
            clientNonce: input.clientNonce ? `send:${message.id}` : undefined,
            sourceMessageId: message.id,
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  thinkingLevel: input.modelPin.thinkingLevel,
                  modelPinned: true,
                }
              : {}),
          },
        });
        if (input.linkMessageToRun) {
          await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        }
      } else if (createRun && busy) {
        const held = !steersRun(busy);
        await tx.steeringMessage.create({
          data: {
            messageId: message.id,
            botId: input.botId,
            userId: input.userId,
            // External deliveries retain their origin and never become app follow-ups.
            runId: held ? null : busy.id,
            ...(input.trigger === "messaging" || input.trigger === "webhook"
              ? { originTrigger: input.trigger }
              : {}),
            ...(input.modelPin
              ? {
                  modelProvider: input.modelPin.modelProvider,
                  modelId: input.modelPin.modelId,
                  thinkingLevel: input.modelPin.thinkingLevel,
                }
              : {}),
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: busy.id } });
      }
      if (
        input.claim &&
        !(await input.claim(tx, { messageId: message.id, runId: run?.id ?? busy?.id ?? null }))
      )
        throw new SendClaimLostError();
      const event = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: run?.id ?? busy?.id,
        payload: {
          messageId: message.id,
          role: "user",
          blocks: input.blocks,
          author,
          // Carries the call id on the live event so a spoken turn groups into the
          // call card immediately, instead of after a refetch reads the nonce.
          callId: callIdFromClientNonce(message.clientNonce),
        },
      });
      return { message, task, run, busy, event };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
  const committed = await commit().catch(async (error) => {
    const winner = await replay();
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  analytics?.capture(
    input.userId,
    { name: "message_sent", trigger: input.trigger },
    { id: committed.message.id, at: committed.message.createdAt },
  );
  await notifyRealtime(realtime, input.threadId, committed.event.seq).catch((error) => {
    // The event is durable; subscribers recover it from their persisted cursor.
    getLogger().error("user message realtime notification", error);
  });
  return {
    messageId: committed.message.id,
    seq: committed.message.seq,
    taskId: committed.task?.id ?? null,
    runId: committed.run?.id ?? committed.busy?.id ?? null,
  };
}

export async function appendEvent(
  prisma: PrismaClient,
  input: AppendEventInput,
  realtime?: RealtimeFanout,
  analytics?: ProductAnalytics,
): Promise<ProductEvent> {
  const event = await insertEventAlone(prisma, input);
  if (
    input.runId &&
    (input.type === "run.started" || input.type === "run.completed" || input.type === "run.failed")
  ) {
    void captureRunAnalytics(prisma, analytics, input.runId, input.type);
  }
  await notifyCommittedEvent(
    prisma,
    realtime,
    input.threadId,
    event.seq,
    event.firstResponse ? input.runId : undefined,
  );
  return mapProductEvent(event);
}

/**
 * appendEventInTransaction as one autocommit statement. Readers trust that events commit in seq
 * order, which the thread row lock taken with the seq guarantees, so that lock is held only while
 * Postgres runs this statement instead of across an interactive transaction's round trips.
 * The run is locked after the thread, as everywhere else, and FOR SHARE checks its newest
 * version, so a run cancelled or re-leased while this waited for the thread writes nothing.
 * A rejected write still uses its seq; readers already skip gaps left by deleted events.
 */
async function insertEventAlone(prisma: PrismaClient, input: AppendEventInput) {
  const activity = isActivityEvent(input);
  const { runId, lease } = input;
  if (input.type === "run.cancelled" && !runId) throw new RunHistoryWriteError();
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload) as Record<string, unknown>;
  const row = {
    id: createRowId(),
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    payload,
  };
  const stored = (await contentEncryptionOf(prisma)?.sealRow("Event", row)) ?? row;
  const runWritable =
    input.type === "run.cancelled"
      ? Prisma.sql`r.status = 'cancelled'`
      : Prisma.join(
          [
            input.allowCancelledRun ? Prisma.sql`TRUE` : Prisma.sql`r.status <> 'cancelled'`,
            lease
              ? Prisma.sql`r."leaseFence" = ${lease.fence}
                  AND (r."leaseOwner" IS NULL OR r."leaseOwner" = ${lease.owner})`
              : Prisma.sql`TRUE`,
            activity
              ? Prisma.sql`r.status = 'running' AND r."leaseOwner" = ${lease?.owner ?? null}`
              : Prisma.sql`TRUE`,
          ],
          " AND ",
        );
  const recordsFirstResponse = Boolean(runId) && isRunResponse(input.type, input.payload);
  const [event] = await prisma.$queryRaw<
    Array<{
      id: string;
      seq: number;
      createdAt: Date;
      runId: string | null;
      firstResponse: boolean;
    }>
  >`
    WITH next AS (
      UPDATE threads SET "nextEventSeq" = "nextEventSeq" + 1
      WHERE id = ${input.threadId}
      RETURNING "nextEventSeq" - 1 AS seq
    ),
    run AS (
      SELECT r.id FROM runs r CROSS JOIN next
      WHERE r.id = ${runId ?? null} AND ${runWritable}
      FOR SHARE OF r
    ),
    inserted AS (
      INSERT INTO events (id, "spaceId", "threadId", "botId", seq, type, payload, "runId")
      SELECT ${row.id}, ${input.spaceId}, ${input.threadId}, ${input.botId}, next.seq,
        ${input.type}, ${JSON.stringify(stored.payload)}::jsonb, ${runId ?? null}
      FROM next
      WHERE ${runId ? Prisma.sql`EXISTS (SELECT 1 FROM run)` : Prisma.sql`TRUE`}
      RETURNING id, seq, "createdAt", "runId"
    ),
    first AS (
      UPDATE runs SET "firstResponseAt" = inserted."createdAt"
      FROM inserted
      WHERE ${recordsFirstResponse} AND runs.id = inserted."runId" AND runs."firstResponseAt" IS NULL
      RETURNING runs.id
    )
    SELECT inserted.*, EXISTS (SELECT 1 FROM first) AS "firstResponse" FROM inserted`;
  if (!event) {
    // Deleting the bot or space cascades the thread and its runs away under in-flight work;
    // that run has no history left to write to.
    if (runId) throw new RunHistoryWriteError();
    throw new Error("Thread not found");
  }
  return { ...row, ...event, type: input.type };
}

export async function finalizeRun(
  prisma: PrismaClient,
  input: FinalizeRunInput,
  realtime?: RealtimeFanout,
  analytics?: ProductAnalytics,
): Promise<FinalizeRunResult | false> {
  const committed = await withTransactionRetry(() => finalizeRunOnce(prisma, input));
  if (!committed) return false;
  await notifyRealtime(realtime, committed.threadId, committed.seq);
  const timing = await readRunTimingFields(prisma, input.runId);
  if (committed.firstResponse) {
    getLogger().info("run.first_response", { "run.id": input.runId, ...timing });
  }
  getLogger().info("run.finished", {
    "run.id": input.runId,
    "run.outcome": input.outcome,
    ...timing,
    "space.id": input.spaceId,
    "thread.id": input.threadId,
    "bot.id": input.botId,
  });
  void captureRunAnalytics(prisma, analytics, input.runId, `run.${input.outcome}`);
  return { continuationRunId: committed.continuationRunId };
}

/** Stamps one turn-level wall-clock duration on the final tool block. */
export function completedRunBlocks(
  blocks: MessageBlock[],
  startedAt: Date | null,
  completedAt: Date,
): MessageBlock[] {
  if (!startedAt) return blocks;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) return blocks;
  const index = blocks.findLastIndex((block) => block.kind === "steps");
  if (index < 0) return blocks;
  return blocks.map((block, blockIndex) =>
    blockIndex === index && block.kind === "steps"
      ? { ...block, durationMs: Math.round(durationMs) }
      : block,
  );
}

// The thread lock is shared with snapshot reads that may hold it for up to 15s. Prisma's 5s
// default counts that wait, and expiring would fail a run whose work already finished.
const FINALIZE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 20_000 };

async function finalizeRunOnce(
  prisma: PrismaClient,
  input: FinalizeRunInput,
): Promise<{
  threadId: string;
  seq: number;
  continuationRunId: string | null;
  firstResponse: boolean;
} | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    let writableRun: { startedAt: Date | null; userId: string } | undefined;
    try {
      writableRun = await assertRunCanWriteHistory(tx, input.runId);
    } catch (error) {
      if (error instanceof RunHistoryWriteError) return null;
      throw error;
    }
    const now = new Date();
    const terminal = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal.count !== 1) return null;
    await tx.externalEffect.deleteMany({
      where: {
        runId: input.runId,
        kind: RUN_TURN_CHECKPOINT_KIND,
        status: RUN_TURN_CHECKPOINT_KIND,
      },
    });

    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: {
        status: input.outcome,
        error: input.outcome === "failed" ? input.error : null,
        finishedAt: now,
      },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to finalize");

    const task = await tx.task.updateMany({
      where: {
        id: input.taskId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
      data: { status: input.outcome },
    });
    if (task.count !== 1) throw new Error("Run task was not available to finalize");

    if (input.outcome === "failed") {
      // Before the partial reply below is saved: a reply the failure cut short answers no
      // steering, so the steering it was answering still gets a run of its own.
      await discardAnsweredSteering(tx, input);
      const { sourceMessage } = await tx.run.findUniqueOrThrow({
        where: { id: input.runId },
        select: { sourceMessage: { select: { seq: true } } },
      });
      // A continuation's source is the newest steering it was created for. Only newer
      // messages justify another run after failure, even if setup failed before claiming.
      await tx.steeringMessage.updateMany({
        where: {
          runId: input.runId,
          message: sourceMessage ? { seq: { gt: sourceMessage.seq } } : undefined,
        },
        data: { runId: null },
      });
    }
    let firstResponse = false;
    // Clients get the blocks without the kept calls, in the message and in its event alike.
    const { blocks: replyBlocks, toolHistory } = splitToolHistory(
      input.outcome === "completed"
        ? completedRunBlocks(input.blocks, writableRun?.startedAt ?? null, now)
        : (input.partialReply ?? []),
    );
    if (replyBlocks.length > 0) {
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        blocks: replyBlocks,
        toolHistory,
        botId: input.botId,
        runId: input.runId,
        ...(input.outcome === "completed"
          ? { markUnread: input.markUnread }
          : { clientNonce: partialReplyClientNonce(input.runId) }),
      });
      const response = await appendEventInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        runId: input.runId,
        payload: { messageId: message.id, role: "bot", blocks: replyBlocks },
      });
      firstResponse = response.firstResponse;
    }
    const lastEvent = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: input.outcome === "completed" ? "run.completed" : "run.failed",
      runId: input.runId,
      payload: input.outcome === "completed" ? {} : { error: input.error },
    });
    await tx.event.deleteMany({
      where: { runId: input.runId, ...transientRunEventsWhere() },
    });
    if (writableRun) {
      await deleteRunSecretsInTransaction(tx, [
        { id: input.runId, userId: writableRun.userId, spaceId: input.spaceId },
      ]);
    }
    if (input.outcome === "completed") {
      await tx.steeringMessage.deleteMany({
        where: { runId: input.runId, claimedAt: { not: null } },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: input.runId },
        data: { runId: null },
      });
    }
    const continuationRunId = await createPendingSteeringRun(tx, input);
    await tx.bot.update({ where: { id: input.botId }, data: { updatedAt: now } });
    return { threadId: lastEvent.threadId, seq: lastEvent.seq, continuationRunId, firstResponse };
  }, FINALIZE_TRANSACTION_OPTIONS);
}

export async function appendEventInTransaction(
  tx: Prisma.TransactionClient,
  input: AppendEventInput,
) {
  const activity = isActivityEvent(input);
  const thread = await tx.thread
    .update({
      where: { id: input.threadId },
      data: { nextEventSeq: { increment: 1 } },
      select: { nextEventSeq: true },
    })
    .catch((error: unknown) => {
      // Deleting the bot or space cascades the thread and its runs away under
      // in-flight work; that run has no history left to write to.
      if (input.runId && isRecordNotFound(error)) throw new RunHistoryWriteError();
      throw error;
    });
  // run.cancelled is appended after the run row already reads cancelled, so it
  // asserts the terminal status where every other event needs a writable run.
  let firstResponseAt: Date | null | undefined;
  if (input.type === "run.cancelled") {
    await assertRunIsCancelled(tx, input.runId);
  } else {
    const run = await assertRunCanWriteHistory(tx, input.runId, {
      allowCancelled: input.allowCancelledRun,
      lease: input.lease,
    });
    if (activity && (run?.status !== "running" || run.leaseOwner !== input.lease?.owner)) {
      throw new RunHistoryWriteError();
    }
    firstResponseAt = run?.firstResponseAt;
  }
  // Unpaired UTF-16 surrogates (e.g. a split emoji high half) are invalid JSON for Postgres.
  const payload = sanitizeJsonValue(input.payload);
  const event = await tx.event.create({
    data: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      seq: thread.nextEventSeq - 1,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      runId: input.runId,
    },
  });
  const firstResponse = Boolean(
    input.runId &&
      !firstResponseAt &&
      isRunResponse(input.type, input.payload) &&
      (
        await tx.run.updateMany({
          where: { id: input.runId, firstResponseAt: null },
          data: { firstResponseAt: event.createdAt },
        })
      ).count === 1,
  );
  return { ...event, firstResponse };
}

/** Thinking markers come only from the run's current lease holder. */
function isActivityEvent(input: AppendEventInput): boolean {
  if (input.type !== "thread.meta" || !hasThinkingActivityMarker(input.payload)) return false;
  ThreadActivityPayloadSchema.parse(input.payload);
  if (!input.runId || !input.lease) throw new RunHistoryWriteError();
  return true;
}

async function captureRunAnalytics(
  prisma: PrismaClient,
  analytics: ProductAnalytics | undefined,
  runId: string,
  type: "run.started" | "run.completed" | "run.failed",
): Promise<void> {
  if (!analytics) return;
  try {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: {
        userId: true,
        trigger: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
    if (!run) return;
    const trigger = AnalyticsTrigger.safeParse(run.trigger);
    if (!trigger.success) return;
    const identity = {
      id: runId,
      at: (type === "run.started" ? run.startedAt : run.completedAt) ?? run.createdAt,
    };
    if (type === "run.failed")
      analytics.capture(
        run.userId,
        {
          name: "run_failed",
          trigger: trigger.data,
          // Only the coarse kind leaves the database; the error text itself never does.
          errorKind: normalizeRunError(run.error ?? "").kind ?? "other",
        },
        identity,
      );
    else
      analytics.capture(
        run.userId,
        { name: type === "run.started" ? "run_started" : "run_completed", trigger: trigger.data },
        identity,
      );
  } catch {
    // Measurement must never turn a committed run into a failed request or worker job.
    getLogger().warn("Run analytics unavailable.");
  }
}
