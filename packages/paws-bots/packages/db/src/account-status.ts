import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import type { ThreadEvents } from "./events.js";
import { appendEventInTransaction, transientRunEventsWhere } from "./events.js";
import { createPendingSteeringRun } from "./thread-steering.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Whether the account may not sign in or run work. A missing account counts as active. */
export async function accountDeactivated(
  db: Pick<PrismaClient, "user">,
  userId: string,
): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { deactivatedAt: true } });
  return Boolean(user?.deactivatedAt);
}

/**
 * Cancels the active runs a deactivated account asked for, one chat at a time, announcing each
 * chat as soon as it commits, and returns how many chats had runs cancelled. Pass `runId` to
 * cancel just that run. Does nothing for an account that is active again. A run already working
 * on a computer sees its cancellation at its next check and releases the computer itself, like
 * any stopped run.
 */
export async function cancelDeactivatedAccountRuns(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "notify">,
  userId: string,
  runId?: string,
): Promise<number> {
  const where = {
    userId,
    status: { in: [...ACTIVE_RUN_STATUSES] },
    ...(runId ? { id: runId } : {}),
  };
  const threads = await prisma.run.findMany({
    where,
    distinct: ["threadId"],
    select: { threadId: true },
  });
  let cancelled = 0;
  for (const { threadId } of threads) {
    const event = await withTransactionRetry(() =>
      prisma.$transaction((tx) => cancelInThread(tx, userId, threadId, where)),
    );
    if (!event) continue;
    cancelled++;
    await events.notify(threadId, event.seq).catch((error) => {
      getLogger().error("deactivated account run cancellation notification", error);
    });
  }
  return cancelled;
}

async function cancelInThread(
  tx: Prisma.TransactionClient,
  userId: string,
  threadId: string,
  where: Prisma.RunWhereInput,
): Promise<{ seq: number } | null> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  // Reactivation can land between the caller's check and this lock.
  if (!(await accountDeactivated(tx, userId))) return null;
  const runs = await tx.run.findMany({
    where: { ...where, threadId },
    select: {
      id: true,
      taskId: true,
      userId: true,
      spaceId: true,
      botId: true,
      status: true,
      leaseExpiresAt: true,
    },
  });
  const now = new Date();
  const cancelled = await cancelRunsInTransaction(tx, runs, now);
  if (!cancelled.length) return null;
  const ids = cancelled.map((run) => run.id);
  // A live worker releases its run's computer once it sees the cancellation. A waiting or
  // queued run has no worker, and one whose lease ran out lost its worker.
  const idle = cancelled
    .filter(
      (run) =>
        (run.status !== "leased" && run.status !== "running") ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now,
    )
    .map((run) => run.id);
  if (idle.length) {
    await expireComputerExecutionLeases(tx, { runId: { in: idle } });
    await tx.computer.updateMany({
      where: { executionRunId: { in: idle } },
      data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
    });
  }
  await tx.steeringMessage.deleteMany({ where: { userId, message: { threadId } } });
  // Teammates' follow-ups that waited behind a cancelled run start now, as they would once it
  // finished; the job reconciler picks the queued run up.
  for (const botId of new Set(cancelled.map((run) => run.botId)))
    await createPendingSteeringRun(tx, { spaceId: cancelled[0]!.spaceId, threadId, botId });
  let seq = 0;
  for (const run of cancelled) {
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId,
      botId: run.botId,
      type: "run.cancelled",
      runId: run.id,
      payload: { reason: "account_deactivated" },
    });
    seq = event.seq;
  }
  await tx.event.deleteMany({ where: { runId: { in: ids }, ...transientRunEventsWhere() } });
  return { seq };
}
