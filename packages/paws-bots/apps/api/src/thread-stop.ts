import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  cancelComputerRunWork,
  returnHelperOutcome,
  screenLeaseIdForRun,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  parseMessagingCommand,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  clearEndedRunState,
  createThreadMessageInTransaction,
  expireComputerExecutionLeases,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  transientRunEventsWhere,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ThreadTarget } from "./thread-target.js";

/** A bare "stop" or "stop now" with nothing attached: the owner's Stop, sent as text. */
export function isStopMessage(input: { text?: string; artifactIds?: string[] }) {
  return !input.artifactIds?.length && parseMessagingCommand(input.text ?? "") === "stop";
}

export const STOPPED_BY_MESSAGE_NOTE = "Stopped. Anything already done stays done.";

export function stoppedRoutineNote(routineName: string) {
  return `Stopped the routine "${routineName}".`;
}

export async function stopThreadRuns(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: ThreadEvents;
  },
  actor: Actor,
  target: ThreadTarget,
  /** Stop only the background helper behind this card in the chat. */
  helperMessageId?: string,
) {
  const stop = await deps.prisma.$transaction(
    cancelThreadRuns(actor, target, undefined, helperMessageId),
    THREAD_LOCK_TRANSACTION_OPTIONS,
  );
  await finishThreadStop(deps, actor, target, stop);
}

/**
 * Stop's database half, run in the caller's transaction: cancels the thread's active runs, and
 * the background helpers it started, and clears its pending steering under the thread lock.
 * `note` says so in the chat when anything was cancelled. `helperMessageId` stops only the
 * helper behind that card. Call finishThreadStop after commit.
 */
export function cancelThreadRuns(
  actor: Pick<Actor, "spaceId">,
  target:
    | { kind: "bot"; botId: string; threadId: string }
    | { kind: "group"; memberBotIds: string[]; threadId: string },
  note?: { botId: string },
  helperMessageId?: string,
) {
  // Background helpers this chat started work in threads of their own.
  const helpers = {
    trigger: BACKGROUND_HELPER_TRIGGER,
    sourceMessage: { threadId: target.threadId },
  };
  return async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const cancelled = await tx.run.updateManyAndReturn({
      where: {
        ...(helperMessageId
          ? { ...helpers, sourceMessageId: helperMessageId }
          : { OR: [{ threadId: target.threadId }, helpers] }),
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      data: { status: "cancelled", completedAt: new Date() },
      select: {
        id: true,
        botId: true,
        userId: true,
        spaceId: true,
        threadId: true,
        trigger: true,
        sourceMessageId: true,
        routineId: true,
        routine: { select: { name: true } },
      },
    });
    const ids = cancelled.map((run) => run.id);
    await clearEndedRunState(tx, ids);
    if (!helperMessageId) {
      await tx.steeringMessage.deleteMany({
        where: {
          botId: { in: target.kind === "bot" ? [target.botId] : target.memberBotIds },
          message: { threadId: target.threadId },
        },
      });
    }
    // Snapshot teardown coordinates before commit. Once cancellation becomes
    // visible, a worker can release its lease / execution columns immediately; a
    // later lookup would then miss the sandbox work this request must stop.
    // Team ownership lives on ComputerExecutionLease; Computer.executionRunId is
    // only a legacy secondary path and is not written by current acquisition.
    const leases = ids.length
      ? await tx.computerExecutionLease.findMany({
          where: { runId: { in: ids } },
          select: { computerId: true, botId: true, runId: true, fence: true },
        })
      : [];
    const leaseComputerIds = [...new Set(leases.map((lease) => lease.computerId))];
    const computers = ids.length
      ? await tx.computer.findMany({
          where:
            leaseComputerIds.length > 0
              ? {
                  OR: [{ id: { in: leaseComputerIds } }, { executionRunId: { in: ids } }],
                }
              : { executionRunId: { in: ids } },
          select: {
            id: true,
            homeKey: true,
            kind: true,
            providerRef: true,
            executionBotId: true,
            executionRunId: true,
          },
        })
      : [];
    // One terminal event per cancelled run, in the same commit as the status
    // flip and the progress purge below. Other clients learn the run ended, and
    // the fresh seq keeps max(seq) above every deleted progress row so a client
    // whose cursor pointed at one never discards later refreshes as stale.
    // Not for a helper in a thread of its own: in the chat it would read as the bot stopping,
    // and the helper's card update tells the chat instead.
    let eventSeq: number | null = null;
    for (const run of cancelled) {
      if (run.threadId !== target.threadId) continue;
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: run.botId,
        type: "run.cancelled",
        runId: run.id,
        payload: {},
      });
      eventSeq = event.seq;
    }
    const named = (run: (typeof cancelled)[number]) =>
      run.trigger === "routine" && run.routine && run.routineId ? run.routine.name : undefined;
    const routineNotes = [
      ...new Map(
        cancelled.flatMap((run) => {
          const name = named(run);
          return name
            ? [[run.routineId, { botId: run.botId, text: stoppedRoutineNote(name) }] as const]
            : [];
        }),
      ).values(),
    ];
    const notes = [
      ...routineNotes,
      ...(note && cancelled.some((run) => !named(run))
        ? [{ botId: note.botId, text: STOPPED_BY_MESSAGE_NOTE }]
        : []),
    ];
    for (const { botId, text } of notes) {
      const blocks: MessageBlock[] = [{ kind: "meta", text }];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "system",
        blocks,
        botId,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "system", blocks },
      });
      eventSeq = event.seq;
    }
    if (ids.length) {
      await tx.event.deleteMany({
        where: {
          ...transientRunEventsWhere(),
          runId: { in: ids },
        },
      });
    }
    return {
      runIds: ids,
      computers,
      leases,
      eventSeq,
      stoppedHelpers: cancelled.filter((run) => run.trigger === BACKGROUND_HELPER_TRIGGER),
    };
  };
}

/** Stop's after-commit half: wakes subscribers, settles stopped helpers' cards, and tears down the cancelled runs' computer work. */
export async function finishThreadStop(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider; events: Pick<ThreadEvents, "notify"> },
  actor: Pick<Actor, "spaceId" | "userId">,
  target: { threadId: string },
  {
    runIds,
    computers,
    leases,
    eventSeq,
    stoppedHelpers,
  }: Awaited<ReturnType<ReturnType<typeof cancelThreadRuns>>>,
) {
  if (eventSeq !== null) {
    // The events are durable; subscribers refetch from their persisted cursor.
    await deps.events.notify(target.threadId, eventSeq).catch((error) => {
      getLogger().error("thread stop realtime notification", error);
    });
  }
  // Settle each stopped helper's card now rather than at the next reconciliation.
  for (const helper of stoppedHelpers) {
    await returnHelperOutcome(deps, helper, { status: "stopped", text: "" }).catch((error) => {
      getLogger().error("stopped helper card", error);
    });
  }
  // Keep the DB lease until after teardown so a replacement run cannot claim the
  // screen while we still need the cancelled run's screenLeaseId to release it.
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));
  const teardownTargets: Array<{
    computer: (typeof computers)[number];
    botId: string;
    runId: string;
    lease: (typeof leases)[number] | null;
  }> = [];
  const seenTargets = new Set<string>();
  for (const lease of leases) {
    const computer = computerById.get(lease.computerId);
    if (!computer) continue;
    const key = `${computer.id}:${lease.runId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: lease.botId,
      runId: lease.runId,
      lease,
    });
  }
  const cancelledRunIds = new Set(runIds);
  for (const computer of computers) {
    if (!computer.executionBotId || !computer.executionRunId) continue;
    // Computers may enter the snapshot via a cancelled lease while
    // Computer.executionRunId still points at an unrelated live run. Only treat
    // the legacy columns as a teardown target when they belong to a run we
    // cancelled in this transaction.
    if (!cancelledRunIds.has(computer.executionRunId)) continue;
    const key = `${computer.id}:${computer.executionRunId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: computer.executionBotId,
      runId: computer.executionRunId,
      lease: null,
    });
  }
  await Promise.all(
    teardownTargets.map(async ({ computer, botId, runId, lease }) => {
      if (!computer.providerRef) return;
      const context = {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        runId,
        screenLeaseId: screenLeaseIdForRun(lease, runId),
        cancelRunWork: true,
        signal: new AbortController().signal,
      };
      const ref = toComputerRef(computer);
      await cancelComputerRunWork(deps.sandbox, ref, computer.id, runId, context);
      await deps.sandbox.releaseScreen?.(ref, context).catch(() => undefined);
    }),
  );
  await expireComputerExecutionLeases(deps.prisma, { runId: { in: runIds } });
  await deps.prisma.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
}
