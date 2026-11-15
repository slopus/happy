import {
  runContinueJob,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type { RunStatus } from "@rakazo/contracts";
import {
  assertTransition,
  BACKGROUND_HELPER_TRIGGER,
  displayName,
  isTerminal,
  nextFence,
  redactSecrets,
  userRunError,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { databaseOutage, retryWhileDatabaseUnavailable, spaceTakesWork } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import { returnHelperOutcome } from "./background-helpers.js";
import { returnBotMessageOutcome } from "./bot-messages.js";
import { VaultKeyUnavailableError } from "./bot-secrets.js";
import { sleepDeferReason } from "./computer-idle.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import { ComputerBusyError, releaseComputerExecutionLease } from "./computer-lifecycle.js";
import { withComputerScreenAvailability } from "./computer-screens.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { RunComputerUseState, RunLeaseState } from "./run-context.js";
import { notifyRun } from "./run-notifications.js";
import type { TakeoverResumeCheckpoint } from "./takeover-resume.js";
import { continueRunClaimFence, TAKEOVER_RESUME_CHECKPOINTS } from "./takeover-resume.js";

/**
 * Avoid an expensive remote workspace export when a turn never touched the computer. A failed
 * export does not fail the run: its work is done, the computer keeps the files, and the idle
 * sleep checkpoints them again before stopping it. Only cancelling the run stops it.
 */
export function createRunWorkspaceCheckpoint(
  checkpoint: () => Promise<unknown>,
  computer: { id: string; kind: string },
  signal?: AbortSignal,
) {
  let dirty = false;
  return {
    markDirty() {
      dirty = true;
    },
    markFiles(files: readonly unknown[]) {
      if (files.length > 0) dirty = true;
    },
    async flush() {
      if (!dirty) return false;
      dirty = false;
      try {
        await checkpoint();
        return true;
      } catch (error) {
        dirty = true;
        if (signal?.aborted) throw error;
        getLogger().warn("computer.checkpoint_deferred", {
          "computer.id": computer.id,
          provider: computer.kind,
          reason: sleepDeferReason(error),
          error,
        });
        return false;
      }
    },
  };
}

export async function computerScreenToolResult(
  work: () => Promise<unknown>,
  finish?: (result: unknown) => Promise<unknown>,
) {
  const result = await withComputerScreenAvailability(work);
  return finish ? finish(result) : result;
}

/** Fails a run that never reached the model and tells the people waiting on it. */
export async function failRunBeforeTurn(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    taskId: string;
    trigger: string;
    routineId?: string | null;
    sourceMessageId?: string | null;
  },
  botName: string,
  lease: { attemptId: string; workerId: string; fence: number },
  message: string,
): Promise<boolean> {
  const failed = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    taskId: run.taskId,
    attemptId: lease.attemptId,
    leaseOwner: lease.workerId,
    leaseFence: lease.fence,
    outcome: "failed",
    error: message,
  });
  if (!failed) return false;
  await enqueueSteeringContinuation(deps, failed.continuationRunId);
  if (run.trigger === "bot_message") {
    await returnBotMessageOutcome(
      deps,
      run,
      { id: run.botId, name: botName },
      `Could not complete the delegated request: ${message}`,
      "status",
      { forceUnread: true },
    ).catch((error) => getLogger().error("bot message failure return", error));
  }
  if (run.trigger === BACKGROUND_HELPER_TRIGGER) {
    // The chat that started the helper hears about its failure there, so it sends no push.
    await returnHelperOutcome(deps, run, { status: "failed", text: message }).catch((error) =>
      getLogger().error("background helper failure return", error),
    );
  } else if (!failed.continuationRunId) {
    await notifyRun(deps, run, {
      kind: "failure",
      title: `${displayName(botName, "Bot")} failed`,
      body: message,
      botId: run.botId,
      threadId: run.threadId,
    });
  }
  return true;
}

/** Queues the steered run that was waiting on this one, if any; a failed enqueue is logged, not thrown. */
export async function enqueueSteeringContinuation(
  deps: Pick<ExecutorDeps, "jobs">,
  continuationRunId: string | null,
): Promise<void> {
  if (!continuationRunId) return;
  await deps.jobs
    .enqueue(runContinueJob(continuationRunId))
    .catch((error) => getLogger().error("steering continuation enqueue", error));
}

export async function renewRunLease(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
): Promise<boolean> {
  const renewed = await deps.prisma.run.updateMany({
    where: {
      id: runId,
      status: "running",
      leaseOwner: workerId,
      leaseFence: fence,
    },
    data: { leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return renewed.count === 1;
}

/** Consecutive setup failures, including this one, after which a run fails instead of retrying. */
export const RUN_SETUP_FAILURE_LIMIT = 8;

/** A paused turn's pending tool is not offered right now, such as while the user's own computer is offline. */
export class PausedTurnToolsUnavailableError extends Error {
  constructor() {
    super(
      "A tool this paused task was using is not available, so it cannot continue. Start the task again.",
    );
    this.name = "PausedTurnToolsUnavailableError";
  }
}

/**
 * Setup failures in a row before the current attempt. Busy-computer and database waits are
 * setup_failed attempts without an error; they neither count nor break the streak.
 */
export async function setupFailureStreak(prisma: PrismaClient, runId: string): Promise<number> {
  const recent = await prisma.attempt.findMany({
    where: {
      runId,
      status: { not: "running" },
      NOT: { status: "setup_failed", error: null },
    },
    orderBy: { fence: "desc" },
    take: RUN_SETUP_FAILURE_LIMIT,
    select: { status: true },
  });
  const streak = recent.findIndex((attempt) => attempt.status !== "setup_failed");
  return streak === -1 ? recent.length : streak;
}

export function computerRetryDelay(fence: number): number {
  return Math.min(10_000, 250 * 2 ** Math.min(Math.max(fence - 1, 0), 5));
}

/**
 * An outage at the computer provider usually lasts minutes, so the retries a run gets before
 * failing are spread over about a quarter of an hour instead of spent within seconds.
 */
export function providerOutageRetryDelay(priorFailures: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(priorFailures, 5));
}

/**
 * A bot uses its computer for one run at a time, and runs that found it held wait without
 * a retry timer. The run releasing it starts the next one due. Runs backing off after a
 * failure keep their delay.
 */
export async function startNextWaitingRun(
  deps: ExecutorDeps,
  botId: string,
  releasedBy: string,
): Promise<void> {
  const next = await deps.prisma.run.findFirst({
    where: {
      botId,
      status: "queued",
      id: { not: releasedBy },
      OR: [{ wakeAt: null }, { wakeAt: { lte: new Date() } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (next) await deps.jobs.enqueue(runContinueJob(next.id));
}

/** Open the model only while this worker still owns the running lease. */
export function mayOpenModelStream(
  run: { status: string; leaseOwner: string | null; leaseFence: number | null } | null,
  workerId: string,
  fence: number,
  aborted: boolean,
): boolean {
  return (
    run?.status === "running" && run.leaseOwner === workerId && run.leaseFence === fence && !aborted
  );
}

function computerRunRequeueData(
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  error: string | null = null,
  heldForTakeover = false,
) {
  return {
    status:
      heldForTakeover && !resumeCheckpoint ? ("waiting_takeover" as const) : ("queued" as const),
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpoint: resumeCheckpoint,
  };
}

export async function writeComputerRunRequeue(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
  error: string | null = null,
  retryAt: Date | null = new Date(Date.now() + computerRetryDelay(fence)),
): Promise<boolean> {
  const whereLease = {
    id: runId,
    status: "running" as const,
    leaseOwner: workerId,
    leaseFence: fence,
  };
  const releasedHold = {
    status: "queued" as const,
    wakeAt: retryAt,
    error,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  const preserve = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  if (preserve.count === 1) return true;
  const planned = await deps.prisma.run.updateMany({
    where: { ...whereLease, checkpoint: null },
    data: {
      ...computerRunRequeueData(resumeCheckpoint, error, heldForTakeover),
      wakeAt: releasedHold.wakeAt,
    },
  });
  if (planned.count === 1) return true;
  const retried = await deps.prisma.run.updateMany({
    where: {
      ...whereLease,
      checkpoint: { in: [...TAKEOVER_RESUME_CHECKPOINTS] },
    },
    data: releasedHold,
  });
  return retried.count === 1;
}

/**
 * This worker stopped working on a run it still owns, because it is stopping or the database
 * went away mid-turn. Queue it to start again. No failure is recorded, and the lease does not
 * keep the next attempt from claiming it.
 */
export async function requeueInterruptedRun(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  wakeAt = new Date(),
): Promise<boolean> {
  const released = await deps.prisma.run.updateMany({
    where: {
      id: runId,
      status: "running",
      leaseOwner: workerId,
      leaseFence: fence,
    },
    data: {
      status: "queued",
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      // Set, so the legacy retry trigger does not hold it back as a failed setup.
      wakeAt,
    },
  });
  if (released.count !== 1) return false;
  await deps.jobs
    .enqueue({ ...runContinueJob(runId), availableAt: wakeAt })
    .catch((error) => getLogger().error("run requeue", error));
  return true;
}

/**
 * `untilReleased` is for a computer another run of the same bot holds: the run waits
 * without a retry timer, and the run releasing the computer starts it.
 */
export async function requeueComputerRun(
  deps: ExecutorDeps,
  runId: string,
  workerId: string,
  fence: number,
  resumeCheckpoint: TakeoverResumeCheckpoint | null,
  heldForTakeover = false,
  untilReleased = false,
): Promise<void> {
  const retryAt = new Date(Date.now() + computerRetryDelay(fence));
  const released = await writeComputerRunRequeue(
    deps,
    runId,
    workerId,
    fence,
    resumeCheckpoint,
    heldForTakeover,
    null,
    untilReleased ? null : retryAt,
  );
  if (!released || untilReleased) return;
  await deps.jobs.enqueue({
    ...runContinueJob(runId),
    availableAt: retryAt,
  });
}

/**
 * Claims a due run for this worker under a new fence and marks it running. Undefined when the
 * run is not due, another worker holds it, or its Space takes no new work.
 */
export async function claimRun(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    status: string;
    checkpoint: string | null;
    leaseFence: number;
  },
  workerId: string,
) {
  const fence = nextFence(run.leaseFence);
  const now = new Date();
  // A Space being deleted starts nothing; its runs wait for the deletion to end or be called
  // off. Its lock comes before the run row, so a claim committing meanwhile is seen.
  const leased = await deps.prisma.$transaction(async (tx) =>
    !(await spaceTakesWork(tx, run.spaceId))
      ? { count: 0 }
      : tx.run.updateMany({
          where: {
            id: run.id,
            ...continueRunClaimFence(run),
            AND: [{ OR: [{ wakeAt: null }, { wakeAt: { lte: now } }] }],
            OR: [
              { status: { in: ["queued", "waiting_input", "waiting_takeover"] } },
              {
                status: { in: ["leased", "running"] },
                leaseExpiresAt: { lte: now },
              },
            ],
          },
          data: {
            status: "leased",
            leaseOwner: workerId,
            leaseFence: fence,
            leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
            error: null,
            checkpoint: null,
            wakeAt: null,
          },
        }),
  );
  if (leased.count !== 1) return undefined;

  const current = await deps.prisma.run.findUniqueOrThrow({
    where: { id: run.id },
  });
  if (
    current.status === "queued" ||
    current.status === "leased" ||
    current.status === "waiting_input" ||
    current.status === "waiting_takeover"
  ) {
    assertTransition(current.status as RunStatus, "running");
  }
  const started = await deps.prisma.run.updateMany({
    where: {
      id: run.id,
      status: "leased",
      leaseOwner: workerId,
      leaseFence: fence,
    },
    data: { status: "running" },
  });
  if (started.count !== 1) return undefined;
  return { fence, current };
}

/**
 * Setup failed before the run's turn: requeue it for another try, or fail it once setup has
 * failed too many times in a row.
 */
export async function retryRunSetup(
  deps: ExecutorDeps,
  run: Parameters<typeof failRunBeforeTurn>[1],
  attempt: { id: string; workerId: string; fence: number },
  plan: {
    resumeCheckpoint: TakeoverResumeCheckpoint | null;
    heldForTakeover: boolean;
    dispatchHandedOff: boolean;
    leaseValid: boolean;
    secrets: string[];
  },
  setupError: unknown,
): Promise<void> {
  const runId = run.id;
  const { workerId, fence } = attempt;
  const { resumeCheckpoint, heldForTakeover, dispatchHandedOff, secrets: runSecrets } = plan;
  // An abort while stopping is not a setup failure, and must not spend the
  // retry budget that eventually fails the run.
  if (deps.shutdownSignal?.aborted) return;
  const computerBusy = setupError instanceof ComputerBusyError;
  // The outage logs itself once, and waiting it out is not a failed setup.
  const databaseDown = databaseOutage.failed(setupError, "run setup");
  const retryForever = computerBusy || databaseDown;
  const setupMessage = redactSecrets(userRunError(setupError), runSecrets);
  const reportedSetupError = sanitizedError(setupError, (text) => redactSecrets(text, runSecrets));
  // An outage at the computer provider or the key manager, or a paused turn's tool going
  // offline, is retried like any setup failure, but is not a Rakazo bug to report.
  const providerOutage =
    setupError instanceof SandboxUnavailableError ||
    setupError instanceof SandboxUnresponsiveError ||
    setupError instanceof PausedTurnToolsUnavailableError ||
    setupError instanceof VaultKeyUnavailableError;
  // A lost lease aborted setup on purpose; whatever that interrupted is not a failure.
  if (databaseDown) {
    // Logged by the outage.
  } else if (providerOutage || !plan.leaseValid) {
    getLogger().warn("run setup failed", { error: reportedSetupError });
  } else if (!computerBusy) {
    getLogger().error("run setup failed", reportedSetupError);
  }
  // Every write below is fenced by this attempt's lease, so each may wait out a failover.
  const whileDatabaseDown = <T>(source: string, write: () => Promise<T>) =>
    retryWhileDatabaseUnavailable(write, { source, signal: deps.shutdownSignal });
  const priorFailures = retryForever
    ? 0
    : await whileDatabaseDown("run setup", () => setupFailureStreak(deps.prisma, runId));
  // The job reconciler re-enqueues a queued run whose job ran out of attempts, so a
  // setup that fails every time would retry forever. End the run instead.
  if (!retryForever && priorFailures >= RUN_SETUP_FAILURE_LIMIT - 1) {
    const bot = await deps.prisma.bot.findUnique({
      where: { id: run.botId },
      select: { name: true },
    });
    await failRunBeforeTurn(
      deps,
      run,
      bot?.name ?? "",
      { attemptId: attempt.id, workerId, fence },
      setupMessage,
    );
    return;
  }
  const retryDelay = providerOutage
    ? providerOutageRetryDelay(priorFailures)
    : computerRetryDelay(fence);
  // One instant for the run and its wake-up job, so neither runs before the other.
  const retryAt = new Date(Date.now() + retryDelay);
  const released = await whileDatabaseDown("run requeue", () =>
    writeComputerRunRequeue(
      deps,
      runId,
      workerId,
      fence,
      resumeCheckpoint,
      heldForTakeover,
      retryForever ? null : "Run setup failed; retrying",
      retryAt,
    ),
  );
  if (released) {
    await whileDatabaseDown("run requeue", () =>
      deps.prisma.attempt.update({
        where: { id: attempt.id },
        data: {
          status: "setup_failed",
          error: retryForever ? null : "Run setup failed; retrying",
          finishedAt: new Date(),
        },
      }),
    );
    if (retryForever || dispatchHandedOff) {
      await deps.jobs.enqueue({
        ...runContinueJob(runId),
        availableAt: retryAt,
      });
      return;
    }
    throw new Error("Run setup failed; retrying", { cause: reportedSetupError });
  }
}

/** Releases what an attempt held, however it ended, and lets the next waiting run start. */
export async function finishRunAttempt(
  deps: ExecutorDeps,
  run: { id: string; botId: string },
  attempt: { id: string; workerId: string; fence: number },
  state: {
    lease: RunLeaseState;
    computerUse: RunComputerUseState;
    computerLease: ComputerExecutionLease | null;
  },
  cleanup: { endRunConnectorState: (runId: string) => void; settleHelpers: () => Promise<void> },
): Promise<void> {
  const runId = run.id;
  const { workerId, fence } = attempt;
  const { lease, computerUse, computerLease } = state;
  const { endRunConnectorState, settleHelpers } = cleanup;
  // This attempt stopped working on the run. Whether it paused, lost the
  // lease, was invalidated by the heartbeat or never finalised, the run
  // row decides whether this worker's run-scoped state may end: a
  // terminal run, or one another worker owns, never resumes here, while a
  // paused or requeued run keeps its sessions for its next attempt. A
  // successful finalisation already ended the state, and the terminal row
  // this reads then only repeats that.
  if (await runEndedForThisWorker(deps.prisma, { runId, leaseOwner: workerId })) {
    endRunConnectorState(runId);
  }
  if (!lease.retainComputer) {
    if (computerUse.screenRelease) {
      const releaseContext = computerUse.screenRelease.keepWarm
        ? { ...computerUse.screenRelease.context, keepScreenWarm: true }
        : computerUse.screenRelease.context;
      await deps.sandbox
        .releaseScreen?.(computerUse.screenRelease.computer, releaseContext)
        .catch(() => undefined);
    }
    await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
    // A stopping process requeues this run instead, and a run handed back after a database
    // outage resumes here; either must keep its turn.
    if (!deps.shutdownSignal?.aborted && !lease.handedBack) {
      await startNextWaitingRun(deps, run.botId, runId).catch((error) =>
        getLogger().error("start next waiting run", error),
      );
    }
  }
  if (deps.shutdownSignal?.aborted) {
    // A renewal still in flight must not treat this release as a lost lease.
    lease.completed = true;
    await requeueInterruptedRun(deps, runId, workerId, fence).catch((error) =>
      getLogger().error("shutdown run requeue", error),
    );
  }
  await deps.prisma.attempt
    .updateMany({
      where: { id: attempt.id, status: "running" },
      data: { status: "interrupted", finishedAt: new Date() },
    })
    .catch(() => undefined);
  await settleHelpers();
}

/** Whether a run this attempt could not finalize is over for this worker: it
 * reached a terminal state or another worker owns it, so its run-scoped state
 * may end. A run re-claimed by this worker under a newer fence — recovered, or
 * requeued after a pause — keeps its state for its next attempt. */
export async function runEndedForThisWorker(
  prisma: ExecutorDeps["prisma"],
  input: { runId: string; leaseOwner: string },
): Promise<boolean> {
  try {
    const run = await prisma.run.findUnique({
      where: { id: input.runId },
      select: { status: true, leaseOwner: true },
    });
    if (!run) return true;
    if (isTerminal(run.status as RunStatus)) return true;
    return run.leaseOwner !== null && run.leaseOwner !== input.leaseOwner;
  } catch {
    // Unknown keeps the state; the connector's idle bound still ends it.
    return false;
  }
}
