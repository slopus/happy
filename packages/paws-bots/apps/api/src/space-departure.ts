import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { expireComputerControl, stopCancelledGroupRuns } from "@rakazo/adapters";
import type { PrismaClient, SpaceDeparture, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * After someone leaves a Space, is removed, or deletes their account: tell clients their runs
 * were cancelled, stop those runs' work, release the screens they held, and start the follow-ups
 * that waited behind them. The departure is committed, so each failure is logged rather than
 * reported; expired leases and the job reconciler catch up.
 */
export async function afterSpaceDeparture(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  actor: { spaceId: string; userId: string },
  departure: SpaceDeparture,
): Promise<void> {
  await Promise.all(
    departure.events.map(({ threadId, seq }) =>
      deps.events.notify(threadId, seq).catch((error) => {
        getLogger().error("space departure realtime notification", error);
      }),
    ),
  );
  await stopCancelledGroupRuns(deps, actor, departure).catch((error) => {
    getLogger().error("space departure run teardown", error);
  });
  await Promise.all(
    departure.heldControls.map(({ computerId, leaseId }) =>
      expireComputerControl(deps, computerId, leaseId).catch((error) => {
        getLogger().error("space departure control release", error);
      }),
    ),
  );
  await Promise.all(
    departure.continuationRunIds.map((runId) =>
      deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
        getLogger().error("steering continuation enqueue", error);
      }),
    ),
  );
}
