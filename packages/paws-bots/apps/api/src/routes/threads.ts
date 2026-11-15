import { ORPCError } from "@orpc/server";
import { createAdapterContext, runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import { settleCallRequest } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  AttachmentValidationError,
  CALL_CLIENT_NONCE_PREFIX,
  callClientNonce,
  expandSkillReferencesInPrompt,
  MODEL_REQUIRED_SEND_ERROR,
  QUEUE_HOLDING_RUN_STATUSES,
} from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  AnswerTooLongError,
  appendEventInTransaction,
  createExternalConversationRepos,
  createThreadMessageInTransaction,
  IsolationError,
  isUniqueViolation,
  loadMessageAuthor,
  lockSpaceGroup,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { answerComputerRequest } from "../computer-control.js";
import type { RouterDeps } from "../router.js";
import { createRoutineTestRun, routineTestRunNonce, routineTestTarget } from "../routines.js";
import { assertTeachingSendAllowed } from "../taught-skills.js";
import { purgeClearedThreadMemory } from "../thread-memory.js";
import {
  isBackgroundRun,
  isPeerRun,
  loadMessagePage,
  shouldForwardBackgroundThreadEvent,
  shouldForwardPeerThreadEvent,
} from "../thread-message-pages.js";
import { reactToThreadMessage } from "../thread-reactions.js";
import {
  markThreadRead,
  markThreadUnreadFrom,
  setThreadSnooze,
  setThreadUnreadState,
} from "../thread-read-state.js";
import { threadSnapshot } from "../thread-snapshot.js";
import { isStopMessage, stopThreadRuns } from "../thread-stop.js";
import type { ThreadTarget } from "../thread-target.js";
import {
  replyParentBotId,
  resolveThreadTarget,
  sendTargetBotIds,
  sendThreadMessage,
  threadHead,
} from "../thread-target.js";
import { mapBotSecretInputError } from "./bots.js";
import type { RouterContext } from "./context.js";
import {
  botsRunOwnModels,
  HEARTBEAT,
  modelSetup,
  THREAD_MESSAGE_PAGE_SIZE,
  withHeartbeats,
} from "./shared.js";

/** Deterministic nonce for a call's marker message. The unique (threadId, clientNonce)
 * index makes it the hang-up idempotency key, and the "call:" prefix lets clients derive
 * the marker's callId. User turns carry a uuid suffix, so they never collide. */
export function callMarkerClientNonce(callId: string): string {
  return `${CALL_CLIENT_NONCE_PREFIX}${callId}:marker`;
}

/** The card is closed by a marker; the run that follows finishes whatever the call left open. */
const HANG_UP_PROMPT =
  "The voice call just ended because the user hung up. First call end_call with a short title for the call (leave farewell empty). Then, if anything the user asked for during the call is still unfinished, complete it now as a normal chat reply with full formatting. If nothing is pending, reply with one short sentence.";

/** A send with routines that already has runs saved under its nonce. */
class SavedSubmission extends Error {}

/** A chat reply hands the screen back to the bot whose run it steers, in a group as in a DM. */
export function takeoverReleaser(deps: RouterDeps, actor: Actor, target: ThreadTarget) {
  return async (runId: string) => {
    const botId =
      target.kind === "bot"
        ? target.botId
        : (
            await deps.prisma.run.findUnique({
              where: { id: runId, spaceId: actor.spaceId },
              select: { botId: true },
            })
          )?.botId;
    if (!botId) return;
    // A reply from someone the bot did not ask still steers it, but answers nothing.
    await answerComputerRequest(deps, actor, botId, "done", runId).catch((error: unknown) => {
      if (!(error instanceof ORPCError)) throw error;
    });
  };
}

export function threadsRoutes(ctx: RouterContext) {
  const { deps, authed, callsEnabled, codexCatalog, repos, agentSkills } = ctx;
  /** The bot a reaction can wake: the thread's bot, or in a group the bot that wrote the message. */
  const reactedBotId = async (target: ThreadTarget, messageId: string) =>
    target.kind === "bot"
      ? target.botId
      : ((
          await deps.prisma.message.findFirst({
            where: { id: messageId, threadId: target.threadId },
            select: { botId: true },
          })
        )?.botId ?? target.memberBotIds[0]!);
  const send = async (
    actor: Actor,
    input: Parameters<typeof sendThreadMessage>[3] & { botId?: string; groupId?: string },
    startRoutines?: Parameters<typeof sendThreadMessage>[5],
  ) => {
    const setup = await modelSetup(deps, actor);
    const target = await resolveThreadTarget(deps.prisma, actor, input);
    // A bot with its own runnable model needs no main model, and stopping work needs none.
    const replied =
      target.kind === "group" ? await replyParentBotId(deps.prisma, target, input) : undefined;
    const noModel =
      setup.needsModel &&
      !(await botsRunOwnModels(deps, actor, sendTargetBotIds(target, input, replied)));
    if (noModel && !isStopMessage(input)) {
      throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
    }
    if (target.kind === "bot") {
      await assertTeachingSendAllowed(deps.prisma, actor.spaceId, target.botId);
    }
    const confirmingImages =
      input.imageHandling === "confirm" && Boolean(input.artifactIds?.length);
    // Reuse the funding modelSetup resolved; a send never asks billing twice.
    const deployment = setup.hasDeployment
      ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
      : null;
    return sendThreadMessage(
      {
        ...deps,
        maxAttachmentsPerMessage: deps.env.maxAttachmentsPerMessage,
        imageAdmission: confirmingImages
          ? {
              secrets: deps.secrets,
              deployment,
              hostedProvider: setup.creditsAvailable ? deployment?.provider : undefined,
              codexCatalog,
            }
          : undefined,
      },
      actor,
      target,
      { ...input, noModel },
      takeoverReleaser(deps, actor, target),
      startRoutines,
    ).catch((error: unknown) => {
      if (error instanceof AttachmentValidationError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    });
  };
  return {
    threads: {
      head: authed.threads.head.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        return threadHead(deps.prisma, target);
      }),
      get: authed.threads.get.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        return threadSnapshot(deps, target, context.actor.userId);
      }),
      messages: authed.threads.messages.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        return loadMessagePage(
          deps.prisma,
          target.threadId,
          input.before,
          THREAD_MESSAGE_PAGE_SIZE,
          input.around,
          input.includePeerRuns,
          input.includePeerReceipts,
        );
      }),
      subscribe: authed.threads.subscribe.handler(async function* ({ context, input }) {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const peerRunCache = new Map<string, Promise<boolean>>();
        const backgroundRunCache = new Map<string, Promise<boolean>>();
        const events = withHeartbeats(context, (signal) =>
          deps.events.follow(target.threadId, input.cursor, signal),
        );
        for await (const event of events) {
          if (event === HEARTBEAT) {
            yield {
              id: "heartbeat",
              spaceId: context.actor.spaceId,
              threadId: target.threadId,
              // A bot thread's id is not the bot. Groups have no single bot, so the thread id stands in.
              botId: target.kind === "bot" ? target.botId : target.threadId,
              seq: 0,
              type: "heartbeat",
              createdAt: new Date().toISOString(),
              payload: {},
            };
            continue;
          }
          if (await isPeerRun(deps.prisma, event.runId, peerRunCache)) {
            if (!shouldForwardPeerThreadEvent(event)) continue;
          } else if (await isBackgroundRun(deps.prisma, event.runId, backgroundRunCache)) {
            if (!shouldForwardBackgroundThreadEvent(event)) continue;
          }
          yield event;
        }
      }),
      send: authed.threads.send.handler(({ context, input }) => send(context.actor, input)),
      sendWithRoutines: authed.threads.sendWithRoutines.handler(async ({ context, input }) => {
        const { actor } = context;
        // The same checks as routines/testRun, all before anything is written.
        const targets = await Promise.all(
          [...new Set(input.routineIds)].map((routineId) =>
            routineTestTarget(deps.prisma, repos, actor, routineId),
          ),
        );
        const skillRecords = await agentSkills.listWithContent(actor);
        const routines = targets.map((target) => ({
          target,
          prompt: expandSkillReferencesInPrompt(target.routine.prompt, skillRecords),
          nonce: routineTestRunNonce(
            actor,
            `routine-mention:${input.clientNonce}:${target.routine.id}`,
          ),
        }));
        const nonces = routines.map((routine) => routine.nonce);
        const savedRuns = (db: Pick<Prisma.TransactionClient, "run">) =>
          db.run.findMany({
            where: { spaceId: actor.spaceId, userId: actor.userId, clientNonce: { in: nonces } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true },
          });
        const startRoutines = async (tx: Prisma.TransactionClient) => {
          // Any saved run means this submission was accepted; it is replayed, never extended. A
          // run another request commits after this lookup fails the insert below the same way.
          if ((await savedRuns(tx)).length) throw new SavedSubmission();
          const runs = [];
          for (const routine of routines) {
            runs.push(
              await createRoutineTestRun(tx, actor, routine.target, routine.prompt, routine.nonce),
            );
          }
          return runs;
        };
        let sent: Awaited<ReturnType<typeof send>> | undefined;
        try {
          if (input.text?.trim() || input.artifactIds?.length) {
            // A saved message for this nonce is replayed before any of this runs.
            sent = await send(actor, input, startRoutines);
          } else {
            // Only the routines: they all commit or none does.
            const started = await withTransactionRetry(() =>
              deps.prisma.$transaction(startRoutines),
            );
            for (const run of started) {
              await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
                getLogger().error("routine mention enqueue", error);
              });
            }
          }
        } catch (error) {
          // A concurrent retry that saved the same runs first wins on the unique key.
          const replay =
            error instanceof SavedSubmission ||
            (isUniqueViolation(error) && (await savedRuns(deps.prisma)).length > 0);
          if (!replay) throw error;
        }
        return {
          routineRunIds: (await savedRuns(deps.prisma)).map((run) => run.id),
          send: sent,
        };
      }),
      react: authed.threads.react.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        // Without a model or while teaching, the reaction is still saved; it just starts no turn.
        const mayStartTurn =
          (!(await modelSetup(deps, context.actor)).needsModel ||
            (await botsRunOwnModels(deps, context.actor, [
              await reactedBotId(target, input.messageId),
            ]))) &&
          (target.kind !== "bot" ||
            (await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId).then(
              () => true,
              () => false,
            )));
        const result = await reactToThreadMessage(
          deps,
          context.actor,
          target,
          { ...input, mayStartTurn },
          takeoverReleaser(deps, context.actor, target),
        );
        if (result.eventSeq != null) {
          await deps.events.notify(target.threadId, result.eventSeq).catch((error) => {
            getLogger().error("thread reaction realtime notification", error);
          });
        }
        return { ok: true as const, runIds: result.runIds };
      }),
      stop: authed.threads.stop.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await stopThreadRuns(deps, context.actor, target);
        return { ok: true as const };
      }),
      stopHelper: authed.threads.stopHelper.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await stopThreadRuns(deps, context.actor, target, input.messageId);
        return { ok: true as const };
      }),
      clear: authed.threads.clear.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const contextBotId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
        if (!contextBotId) throw new IsolationError();
        const { cancelledRunIds, historyCompactionGeneration, removedStorageKeys } =
          await deps.events.clearThread({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId: contextBotId,
            ...(target.kind === "group" ? { groupId: target.groupId } : {}),
          });
        await Promise.all(
          cancelledRunIds.map((runId) => deps.jobs.cancel(runJobKey(runId)).catch(() => undefined)),
        );
        const removal = createAdapterContext(
          context.actor,
          contextBotId,
          `thread-clear:${target.threadId}`,
        );
        await Promise.all(
          removedStorageKeys.map((storageKey) =>
            deps.artifacts.remove(storageKey, removal).catch(() => undefined),
          ),
        );
        await purgeClearedThreadMemory(deps, context.actor, target, historyCompactionGeneration);
        return { ok: true as const };
      }),
      followUp: authed.threads.followUp.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind === "bot") {
          await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
          const sent = await deps.events.sendUserMessage({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            userId: context.actor.userId,
            authorUserId: context.actor.userId,
            blocks: [{ kind: "text", text: input.text }],
            prompt: input.text,
            trigger: "follow_up",
            clientNonce: input.clientNonce,
          });
          if (sent.taskId && sent.runId) {
            await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
              getLogger().error("follow-up enqueue", error);
            });
          }
          return { ok: true as const };
        }
        const committed = await deps.prisma.$transaction(async (tx) => {
          if (input.clientNonce) {
            const existing = await tx.message.findUnique({
              where: {
                threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
              },
            });
            if (existing) return null;
          }
          await lockSpaceGroup(tx, context.actor, target.groupId);
          const group = await tx.chatGroup.findFirst({
            where: {
              id: target.groupId,
              archivedAt: null,
              thread: { id: target.threadId },
            },
            include: { members: { orderBy: [{ createdAt: "asc" }, { botId: "asc" }] } },
          });
          const botId = group?.members[0]?.botId;
          if (!botId) throw new IsolationError();
          const blocks = [{ kind: "text" as const, text: input.text }];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: target.threadId,
            role: "user",
            authorUserId: context.actor.userId,
            blocks,
            clientNonce: input.clientNonce,
          });
          const author = await loadMessageAuthor(tx, context.actor.userId);
          const active = await tx.run.findFirst({
            where: {
              threadId: target.threadId,
              botId,
              status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
            },
            select: { id: true, userId: true },
          });
          let run: { id: string } | null = null;
          // Another person's message waits for a run of its own, which acts with their
          // accounts, rather than joining the one under way.
          const ownRunId = active?.userId === context.actor.userId ? active.id : null;
          if (!active) {
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                userId: context.actor.userId,
                prompt: input.text,
                status: "queued",
              },
            });
            run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId: target.threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "follow_up",
                sourceMessageId: message.id,
              },
              select: { id: true },
            });
            await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
          } else {
            await tx.steeringMessage.create({
              data: { messageId: message.id, botId, userId: context.actor.userId, runId: ownRunId },
            });
            if (ownRunId) {
              await tx.message.update({ where: { id: message.id }, data: { runId: ownRunId } });
            }
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            botId,
            type: "thread.message.created",
            runId: run?.id ?? ownRunId ?? undefined,
            payload: { messageId: message.id, role: "user", blocks, author },
          });
          await touchGroupUpdatedAt(tx, target.groupId);
          return { runId: run?.id, eventSeq: event.seq, message };
        }, THREAD_LOCK_TRANSACTION_OPTIONS);
        if (committed) {
          deps.analytics?.capture(
            context.actor.userId,
            { name: "message_sent", trigger: "follow_up" },
            { id: committed.message.id, at: committed.message.createdAt },
          );
          await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
            getLogger().error("group follow-up realtime notification", error);
          });
          if (committed.runId) {
            await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
              getLogger().error("group follow-up enqueue", error);
            });
          }
        }
        return { ok: true as const };
      }),
      answerCall: callsEnabled.threads.answerCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        const answered = await settleCallRequest(deps, {
          threadId: target.threadId,
          callId: input.callId,
          from: ["ringing"],
          status: "answered",
        });
        if (answered?.status !== "answered")
          throw new ORPCError("CONFLICT", { message: "This call is no longer ringing." });
        return { opening: answered.opening, reason: answered.reason };
      }),
      declineCall: callsEnabled.threads.declineCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        const declined = await settleCallRequest(deps, {
          threadId: target.threadId,
          callId: input.callId,
          from: ["ringing"],
          status: input.outcome,
        });
        if (declined?.status !== input.outcome)
          throw new ORPCError("CONFLICT", { message: "This call is no longer ringing." });
        return { ok: true as const };
      }),
      endCall: callsEnabled.threads.endCall.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (target.kind !== "bot") throw new IsolationError();
        await assertTeachingSendAllowed(deps.prisma, context.actor.spaceId, target.botId);
        const { botId, threadId } = target;
        // The bot's own call: its card keeps how long the user stayed on.
        await settleCallRequest(deps, {
          threadId,
          callId: input.callId,
          from: ["answered"],
          ...(input.durationSeconds === undefined
            ? {}
            : { durationSeconds: input.durationSeconds }),
        });
        const blocks = [
          {
            kind: "voice_call" as const,
            callId: input.callId,
            title: "",
            farewell: "",
            ...(input.durationSeconds === undefined
              ? {}
              : { durationSeconds: input.durationSeconds }),
          },
        ];
        const committed = await deps.prisma
          .$transaction(async (tx) => {
            // A late provider hang-up is harmless when the call never produced a
            // user utterance; do not create a phantom marker or follow-up run.
            const userUtterance = await tx.message.findFirst({
              where: {
                threadId,
                role: "user",
                clientNonce: { startsWith: `${CALL_CLIENT_NONCE_PREFIX}${input.callId}:` },
              },
              select: { id: true },
            });
            if (!userUtterance) return null;
            // The marker's deterministic nonce is the idempotency key: the unique
            // (threadId, clientNonce) index rejects a second hang-up, concurrent or not.
            const message = await createThreadMessageInTransaction(tx, {
              threadId,
              role: "bot",
              botId,
              blocks,
              clientNonce: callMarkerClientNonce(input.callId),
            });
            await appendEventInTransaction(tx, {
              spaceId: context.actor.spaceId,
              threadId,
              botId,
              type: "thread.message.created",
              payload: { messageId: message.id, role: "bot", blocks, callId: input.callId },
            });
            const task = await tx.task.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId,
                userId: context.actor.userId,
                prompt: HANG_UP_PROMPT,
                status: "queued",
              },
            });
            const run = await tx.run.create({
              data: {
                spaceId: context.actor.spaceId,
                botId,
                threadId,
                taskId: task.id,
                userId: context.actor.userId,
                status: "queued",
                trigger: "call_end",
                clientNonce: callClientNonce(input.callId),
              },
              select: { id: true },
            });
            const ended = await appendEventInTransaction(tx, {
              spaceId: context.actor.spaceId,
              threadId,
              botId,
              type: "thread.call.ended",
              runId: run.id,
              payload: {
                botId,
                threadId,
                callId: input.callId,
                title: "",
                farewell: "",
                messageId: message.id,
              },
            });
            return { runId: run.id, eventSeq: ended.seq };
          })
          .catch((error) => {
            if (!isUniqueViolation(error)) throw error;
            return null;
          });
        if (!committed) return { ok: true as const };
        await deps.events.notify(threadId, committed.eventSeq).catch((error) => {
          getLogger().error("call end realtime notification", error);
        });
        // The queued run is durable; a missed wake is repaired by the reconciler.
        await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
          getLogger().error("call end enqueue", error);
        });
        return { ok: true as const };
      }),
      answer: authed.threads.answer.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const answered = await deps.events
          .answerRunInput({
            spaceId: context.actor.spaceId,
            threadId: target.threadId,
            runId: input.runId,
            messageId: input.messageId,
            answeredByUserId: context.actor.userId,
            answer: input.answer,
            clientNonce: input.clientNonce,
            fields: input.fields,
            username: input.username,
            remember: input.remember,
            dismiss: input.dismiss,
          })
          .catch((error: unknown) => {
            if (error instanceof AnswerTooLongError)
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            // A typed credential its destination cannot carry (e.g. a header with a line break).
            throw mapBotSecretInputError(error);
          });
        if (!answered) {
          throw new ORPCError("CONFLICT", {
            message: "This prompt is no longer awaiting an answer",
          });
        }
        await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
          // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
          getLogger().error("thread answer enqueue", error);
        });
        return { ok: true as const };
      }),
      markRead: authed.threads.markRead.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const unreadAfterSeq = await markThreadRead(deps.prisma, context.actor, target);
        return { ok: true as const, unreadAfterSeq };
      }),
      markUnread: authed.threads.markUnread.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        if (input.messageId) {
          await markThreadUnreadFrom(deps.prisma, context.actor, target, input.messageId);
        } else {
          await setThreadUnreadState(deps.prisma, context.actor, target, true);
        }
        return { ok: true as const };
      }),
      snooze: authed.threads.snooze.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        await setThreadSnooze(deps.prisma, context.actor, target, input.until);
        return { ok: true as const };
      }),
    },
    externalConversations: {
      updatePolicy: authed.externalConversations.updatePolicy.handler(
        async ({ context, input }) => {
          const { externalConversationId, ...policy } = input;
          return createExternalConversationRepos(deps.prisma).updatePolicy(
            context.actor,
            externalConversationId,
            policy,
          );
        },
      ),
    },
  };
}
