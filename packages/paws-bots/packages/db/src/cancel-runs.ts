import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { clearEndedRunState } from "./run-secrets.js";

/**
 * The caller selects authorized runs and owns the surrounding transaction and cleanup. Returns
 * the runs this cancelled: one that finished after the caller's read keeps its outcome.
 */
export async function cancelRunsInTransaction<
  Run extends { id: string; taskId: string; userId: string; spaceId: string },
>(
  tx: Pick<
    Prisma.TransactionClient,
    "run" | "attempt" | "task" | "externalEffect" | "secret" | "message"
  >,
  runs: ReadonlyArray<Run>,
  cancelledAt: Date,
): Promise<Run[]> {
  if (runs.length === 0) return [];
  const cancelledIds = new Set(
    (
      await tx.run.updateManyAndReturn({
        where: { id: { in: runs.map((run) => run.id) }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: {
          status: "cancelled",
          completedAt: cancelledAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
        select: { id: true },
      })
    ).map((run) => run.id),
  );
  const cancelled = runs.filter((run) => cancelledIds.has(run.id));
  if (cancelled.length === 0) return [];
  const runIds = cancelled.map((run) => run.id);
  await clearEndedRunState(tx, runIds);
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: cancelled.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
  return cancelled;
}
