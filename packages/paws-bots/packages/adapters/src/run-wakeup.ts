import { monitorEventLoopDelay } from "node:perf_hooks";
import type {
  BackgroundJob,
  BackgroundJobHandlers,
  JobPublisher,
  JobTransaction,
  JobWorkerHost,
  RealtimeFanout,
} from "@rakazo/adapter-kit";
import { dispatchBackgroundJob } from "@rakazo/adapter-kit";
import type { DatabaseOutage, Prisma, PrismaClient } from "@rakazo/db";
import {
  databaseOutage,
  endTakeoverWaits,
  isTooManyDatabaseConnections,
  runAsSystem,
} from "@rakazo/db";
import { getLogger, runCorrelatedJob } from "@rakazo/logging";
import type { Pool } from "pg";
import { RunExecutionHost } from "./run-execution.js";
import { findRunRecoveryBlockers } from "./run-recovery.js";

const RUN_READY_TOPIC = "runs:ready";
const INTERACTIVE_QUEUE_WARNING_MS = 30_000;
const RESUMABLE = ["queued", "waiting_input", "waiting_takeover"];

/**
 * Starts runs in this process the moment they become due, each as its own task, so no
 * run waits behind another. A process that cannot take a run hands it to the others.
 */
export class RunStarter {
  private readonly executions = new RunExecutionHost();
  private readonly inFlight = new Set<string>();
  /** Runs made due again while this process was still finishing them. */
  private readonly dueAgain = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private handlers: BackgroundJobHandlers | undefined;
  private stopping = false;

  constructor(
    private readonly realtime: RealtimeFanout,
    private readonly options: { signal?: AbortSignal } = {},
  ) {}

  attach(handlers: BackgroundJobHandlers): void {
    this.handlers = handlers;
    this.stopping = false;
    this.executions.start();
  }

  get activeRuns(): number {
    return this.executions.activeCount;
  }

  /** Starts a run created or woken in this process, or hands it to another process. */
  start(runId: string, at?: Date): void {
    const delay = at ? at.getTime() - Date.now() : 0;
    if (delay <= 0) {
      void this.begin(runId, true);
      return;
    }
    // Recovery starts a future run on time if this process is leaving.
    if (!this.accepting) return;
    clearTimeout(this.timers.get(runId));
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      void this.begin(runId, true);
    }, delay);
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  /** Starts a run another process handed over or recovery found; never hands it on again. */
  take(runId: string): void {
    void this.begin(runId, false);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dueAgain.clear();
    await this.executions.stop();
  }

  private get accepting(): boolean {
    return Boolean(this.handlers) && !this.stopping && !this.options.signal?.aborted;
  }

  private handOff(runId: string): void {
    // Without a listening process the durable row waits for recovery.
    void this.realtime.publish(RUN_READY_TOPIC, runId).catch((error) => {
      getLogger().error("run handoff notification", error);
    });
  }

  private async begin(runId: string, local: boolean): Promise<void> {
    if (this.inFlight.has(runId)) {
      if (local) this.dueAgain.add(runId);
      return;
    }
    const handlers = this.handlers;
    if (!handlers || !this.accepting) {
      if (local) this.handOff(runId);
      return;
    }
    this.inFlight.add(runId);
    let admitted = false;
    try {
      admitted = await this.executions.execute(
        (execution) =>
          runCorrelatedJob({
            name: "run.continue",
            payload: { runId },
            run: () =>
              runAsSystem("run dispatch", () =>
                dispatchBackgroundJob(handlers, "run.continue", { runId }, execution).finally(() =>
                  this.finished(runId),
                ),
              ),
          }),
        { waitForCapacity: false },
      );
    } catch {
      // The durable run remains discoverable. Lease expiry handles failures
      // after a claim; the normal executor handles bounded setup retries.
      this.finished(runId);
      return;
    }
    if (admitted) return;
    this.inFlight.delete(runId);
    this.dueAgain.delete(runId);
    if (local) this.handOff(runId);
  }

  private finished(runId: string): void {
    this.inFlight.delete(runId);
    if (this.dueAgain.delete(runId)) void this.begin(runId, true);
  }
}

/** Runs are durable in Postgres and start in the process that makes them due. */
export class RunJobPublisher implements JobPublisher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly background: JobPublisher,
    private readonly starter: RunStarter,
  ) {}

  async enqueue(job: BackgroundJob): Promise<void> {
    if (job.name !== "run.continue") return this.background.enqueue(job);
    await this.prisma.run.updateMany({
      where: {
        id: job.payload.runId,
        status: { in: RESUMABLE },
        ...(job.keepExisting ? { wakeAt: null } : {}),
      },
      data: { wakeAt: job.availableAt ?? new Date() },
    });
    this.starter.start(job.payload.runId, job.availableAt);
  }

  async enqueueIn(tx: JobTransaction, job: BackgroundJob): Promise<void> {
    await this.background.enqueueIn(tx, job);
  }

  async cancelIn(tx: JobTransaction, key: string): Promise<void> {
    await this.background.cancelIn(tx, key);
  }

  async cancel(key: string): Promise<void> {
    // The durable status is already cancelled. Legacy Graphile deliveries can
    // safely drain as no-ops; chat cancellation needs no scheduler connection.
    if (!key.startsWith("run:")) await this.background.cancel(key);
  }

  async close(): Promise<void> {
    await this.background.close();
  }
}

/**
 * Takes runs other processes hand over, and recovers runs whose process died or whose
 * start was lost. Neither is on the path a new run takes to start.
 */
export class RunWorkerHost implements JobWorkerHost {
  private unsubscribe: (() => Promise<void>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning: Promise<void> | undefined;
  private scanAgain = false;
  private wakeRequested = false;
  private readonly cursors: Record<
    "interactive" | "background",
    { createdAt: Date; id: string } | undefined
  > = { interactive: undefined, background: undefined };
  private readonly laneDone = { interactive: false, background: false };
  private nextQueueCheckAt = 0;
  private queueCheck: Promise<void> | undefined;
  private queueDelayed = false;
  private stopping = true;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(
    private readonly prisma: PrismaClient,
    private readonly realtime: RealtimeFanout,
    private readonly starter: RunStarter,
    private readonly options: {
      intervalMs?: number;
      batchSize?: number;
      pool?: Pool;
      outage?: DatabaseOutage;
    } = {},
  ) {}

  private get outage(): DatabaseOutage {
    return this.options.outage ?? databaseOutage;
  }

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    this.cursors.interactive = undefined;
    this.cursors.background = undefined;
    this.laneDone.interactive = false;
    this.laneDone.background = false;
    this.nextQueueCheckAt = 0;
    this.queueDelayed = false;
    this.wakeRequested = false;
    this.starter.attach(handlers);
    this.eventLoopDelay.enable();
    try {
      // A release before handoffs carried a run id notifies with an empty payload.
      this.unsubscribe = await this.realtime.subscribe(RUN_READY_TOPIC, (runId) =>
        runId ? this.starter.take(runId) : this.wake(),
      );
    } catch (error) {
      this.stopping = true;
      this.eventLoopDelay.disable();
      throw error;
    }
    this.timer = setInterval(() => this.wake(), this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.eventLoopDelay.disable();
    await this.unsubscribe?.();
    await this.starter.stop();
    await this.scanning;
  }

  private wake(): void {
    if (this.stopping) return;
    this.checkQueueAge();
    this.scanAgain = true;
    this.wakeRequested = true;
    if (this.scanning) return;
    this.scanning = runAsSystem("run recovery scan", async () => {
      try {
        while (this.scanAgain && !this.stopping) {
          this.scanAgain = false;
          await this.scan();
        }
        this.outage.succeeded();
      } catch (error) {
        this.scanAgain = false;
        if (!this.stopping && !this.outage.failed(error, "run recovery scan"))
          getLogger().error("run dispatch scan", error);
      }
    }).finally(() => {
      this.scanning = undefined;
      if (this.scanAgain && !this.stopping) this.wake();
    });
  }

  /**
   * Runs waiting for their own bot's earlier run on its computer are expected to wait, including
   * in the handoff after that run releases the computer (release expires the lease and touches
   * `updatedAt`) until the next one takes it.
   * Any other run still unstarted thirty seconds after it was due means starting failed,
   * which is an error reported with this process's database pool and event-loop health. A run
   * is due from its last write, so one resumed after an approval or reply is not counted late.
   */
  private checkQueueAge(): void {
    const now = Date.now();
    if (this.queueCheck || now < this.nextQueueCheckAt) return;
    this.nextQueueCheckAt = now + INTERACTIVE_QUEUE_WARNING_MS;
    this.queueCheck = runAsSystem("interactive queue health", async () => {
      const cutoff = new Date(now - INTERACTIVE_QUEUE_WARNING_MS);
      const [delayed] = await this.prisma.$queryRaw<
        { delayedRuns: number; oldestDueAt: Date | null; oldestRunId: string | null }[]
      >`
        SELECT COUNT(*)::int AS "delayedRuns",
               MIN(GREATEST(runs."updatedAt", COALESCE(runs."wakeAt", runs."updatedAt")))
                 AS "oldestDueAt",
               (ARRAY_AGG(runs.id ORDER BY
                 GREATEST(runs."updatedAt", COALESCE(runs."wakeAt", runs."updatedAt"))))[1]
                 AS "oldestRunId"
        FROM runs
        JOIN bots bot ON bot.id = runs."botId"
        WHERE runs.status = 'queued' AND runs.trigger NOT IN ('routine', 'reaction')
          AND runs."updatedAt" <= ${cutoff}
          AND (runs."wakeAt" IS NULL OR runs."wakeAt" <= ${cutoff})
          AND NOT EXISTS (
            SELECT 1 FROM computer_execution_leases lease
            WHERE lease."botId" = runs."botId" AND lease."computerId" = bot."computerId"
              AND lease."runId" <> runs.id
              AND (lease."expiresAt" > ${new Date(now)} OR lease."updatedAt" > ${cutoff})
          )
      `;
      if (this.stopping) return;
      if (delayed?.delayedRuns && delayed.oldestDueAt) {
        this.queueDelayed = true;
        getLogger().error("run.queue_delayed", {
          "queue.delayed_runs": delayed.delayedRuns,
          "queue.oldest_wait_ms": Math.max(0, now - delayed.oldestDueAt.getTime()),
          "queue.oldest_run_id": delayed.oldestRunId,
          "queue.warning_after_ms": INTERACTIVE_QUEUE_WARNING_MS,
          ...this.processHealth(),
        });
      } else if (this.queueDelayed) {
        this.queueDelayed = false;
        getLogger().info("run.queue_recovered");
      }
    })
      .catch((error) => {
        if (!this.stopping && !this.outage.failed(error, "run queue health"))
          getLogger().error("run queue health", error);
      })
      .finally(() => {
        this.queueCheck = undefined;
      });
  }

  private processHealth() {
    const pool = this.options.pool;
    const health = {
      "worker.active_runs": this.starter.activeRuns,
      "event_loop.delay_max_ms": Math.round(this.eventLoopDelay.max / 1e6),
      "event_loop.delay_p99_ms": Math.round(this.eventLoopDelay.percentile(99) / 1e6),
      ...(pool
        ? {
            "db.pool.total": pool.totalCount,
            "db.pool.idle": pool.idleCount,
            "db.pool.waiting": pool.waitingCount,
          }
        : {}),
    };
    this.eventLoopDelay.reset();
    return health;
  }

  private async scan(): Promise<void> {
    // New work can arrive after either lane's query snapshot. External wakes
    // reopen completed lanes without restarting either lane's active pagination.
    if (this.wakeRequested) {
      this.laneDone.interactive = false;
      this.laneDone.background = false;
      this.wakeRequested = false;
    }
    if (!this.laneDone.interactive) await this.scanLane("interactive");
    if (!this.stopping && !this.laneDone.background) await this.scanLane("background");
    if (this.laneDone.interactive && this.laneDone.background) {
      this.laneDone.interactive = false;
      this.laneDone.background = false;
    } else this.scanAgain = true;
  }

  private async scanLane(lane: "interactive" | "background"): Promise<void> {
    const cursor = this.cursors[lane];
    const now = new Date();
    const due: Prisma.RunWhereInput = {
      OR: [{ wakeAt: null }, { wakeAt: { lte: now } }],
    };
    const batchSize = this.options.batchSize ?? 100;
    const rows = await this.prisma.run.findMany({
      where: {
        trigger:
          lane === "background"
            ? { in: ["routine", "reaction"] }
            : { notIn: ["routine", "reaction"] },
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
        OR: [
          { status: "queued", AND: [due] },
          { status: { in: ["leased", "running"] }, leaseExpiresAt: { lte: now } },
          { status: { in: ["waiting_input", "waiting_takeover"] }, wakeAt: { lte: now } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: {
        id: true,
        createdAt: true,
        botId: true,
        status: true,
        trigger: true,
        bot: { select: { computerId: true } },
      },
    });
    // The executor still acquires the lease atomically to handle races here.
    const blockers = await findRunRecoveryBlockers(this.prisma, rows, now);
    const runnable = rows.filter((row) => !blockers.has(row.id));
    // A takeover request holds its bot's computer. Chat work must not wait behind one the user
    // has not acted on, so end it; the freed rows start on the next scan.
    if (lane === "interactive") {
      const holders = new Set(
        rows.flatMap((row) => {
          const holder = row.status === "queued" ? blockers.get(row.id) : undefined;
          return holder ? [holder] : [];
        }),
      );
      if (holders.size) {
        const ended = await endTakeoverWaits(this.prisma, [...holders], this.realtime).catch(
          (error) => {
            getLogger().error("takeover wait release", error);
            return 0;
          },
        );
        if (ended) this.wake();
      }
    }
    for (const row of runnable) {
      if (this.stopping) break;
      this.starter.take(row.id);
    }
    if (rows.length === batchSize) {
      this.cursors[lane] = rows.at(-1);
    } else {
      this.cursors[lane] = undefined;
      this.laneDone[lane] = true;
    }
  }
}

/** Start direct execution even if the background scheduler is temporarily unavailable. */
export function withRunWorker(runs: RunWorkerHost, background: JobWorkerHost): JobWorkerHost {
  let stopping = false;
  let starting: Promise<void> | undefined;
  return {
    start(handlers) {
      if (stopping) return Promise.resolve();
      if (starting) return starting;
      starting = (async () => {
        try {
          await runs.start(handlers);
          if (!stopping) await background.start(handlers);
        } catch (error) {
          if (!isTooManyDatabaseConnections(error)) {
            await Promise.allSettled([runs.stop(), background.stop()]);
          }
          throw error;
        }
      })().finally(() => {
        starting = undefined;
      });
      return starting;
    },
    async stop() {
      stopping = true;
      // A scheduler start already in flight can create listeners after its first
      // stop. Wait for startup, then stop it again before releasing dependencies.
      const results = await Promise.allSettled([runs.stop(), background.stop(), starting]);
      await background.stop();
      const failed = results.slice(0, 2).find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
