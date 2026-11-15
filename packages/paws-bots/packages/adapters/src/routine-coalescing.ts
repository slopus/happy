import type { Prisma } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";

/** Reserved provenance for recurring timer ticks; manual/event/retry runs never use it. */
export function routineTimerNonce(routineId: string, scheduledFor: string): string {
  return `routine-timer:${routineId}:${scheduledFor}`;
}

/** The scheduled occurrence a recurring timer run was created for, if it is one. */
export function routineTimerScheduledFor(
  routineId: string,
  clientNonce: string | null | undefined,
): Date | undefined {
  const prefix = routineTimerNonce(routineId, "");
  if (!clientNonce?.startsWith(prefix)) return undefined;
  const scheduledFor = new Date(clientNonce.slice(prefix.length));
  return Number.isFinite(scheduledFor.getTime()) ? scheduledFor : undefined;
}

/**
 * Call while holding the routine row lock. Keep at most one unstarted catch-up
 * for the same work; never fold an event, manual test, retry, or actually attempted run.
 */
export async function findPendingRoutineTick(
  tx: Prisma.TransactionClient,
  config: {
    routineId: string;
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    prompt: string;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string | null;
    modelPinned?: true;
  },
) {
  const pristine: Prisma.RunWhereInput = {
    routineId: config.routineId,
    // Older firings did not distinguish recurring ticks from one-shot schedules.
    // Preserve all ambiguous legacy work, even when routine.fired was recorded.
    clientNonce: { startsWith: `routine-timer:${config.routineId}:` },
    spaceId: config.spaceId,
    botId: config.botId,
    userId: config.userId,
    threadId: config.threadId,
    trigger: "routine",
    status: "queued",
    retryOfRunId: null,
    sourceMessageId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: null,
    firstResponseAt: null,
    checkpoint: null,
    error: null,
    modelProvider: config.modelProvider ?? null,
    modelId: config.modelId ?? null,
    thinkingLevel: config.thinkingLevel ?? null,
    modelPinned: config.modelPinned ?? false,
    attempts: { none: {} },
    effects: { none: {} },
    steeringMessages: { none: {} },
    task: { status: "queued", prompt: config.prompt },
  };
  const candidates = await tx.run.findMany({
    where: pristine,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, leaseFence: true, updatedAt: true },
    take: 100,
  });
  if (!candidates.length) return null;
  const runIds = candidates.map((candidate) => candidate.id);
  const leases = await tx.computerExecutionLease.findMany({
    where: { runId: { in: runIds }, expiresAt: { gt: new Date() } },
    select: { runId: true },
  });
  const held = new Set(leases.map(({ runId }) => runId));
  let retained: { id: string; taskId: string } | null = null;
  const cancelledEvents: { threadId: string; seq: number }[] = [];
  for (const candidate of candidates) {
    // A stale pre-attempt timestamp/fence does not prove execution. Attempts,
    // effects, checkpoints and live computer ownership do.
    if (held.has(candidate.id)) continue;
    // Dispatch can race the earlier read. Lock and recheck, including its exact
    // fence, so work claimed since the selection is never folded or cancelled.
    const locked = await tx.run.updateMany({
      where: { ...pristine, id: candidate.id, leaseFence: candidate.leaseFence },
      data: retained
        ? {
            status: "cancelled",
            completedAt: new Date(),
            wakeAt: null,
            leaseFence: { increment: 1 },
          }
        : { updatedAt: candidate.updatedAt },
    });
    if (locked.count !== 1) continue;
    if (!retained) {
      retained = { id: candidate.id, taskId: candidate.taskId };
      continue;
    }
    // Keep historical rows and terminal events; only redundant, unstarted timer
    // occurrences disappear from the runnable backlog.
    await tx.task.updateMany({
      where: { id: candidate.taskId, status: "queued", runs: { every: { status: "cancelled" } } },
      data: { status: "cancelled" },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: config.spaceId,
      threadId: config.threadId,
      botId: config.botId,
      type: "run.cancelled",
      runId: candidate.id,
      payload: { reason: "routine_coalesced", supersededByRunId: retained.id },
    });
    cancelledEvents.push({ threadId: config.threadId, seq: event.seq });
  }
  return retained && { ...retained, ...(cancelledEvents.length ? { cancelledEvents } : {}) };
}
