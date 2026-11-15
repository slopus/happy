import { setImmediate } from "node:timers/promises";
import type { JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import { routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, stuckWorkStatusMessages } from "@rakazo/core";
import type { DatabaseOutage, Pool, PrismaClient, ThreadEvents } from "@rakazo/db";
import { databaseOutage, reconcileComputerRuns } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PoolClient } from "pg";
import { returnHelperOutcome } from "./background-helpers.js";
import { returnBotMessageOutcome } from "./bot-messages.js";
import { reconcileCallRequests } from "./call-request.js";
import { scheduleComputerControlExpiry } from "./computer-control.js";
import { findRunRecoveryBlockers } from "./run-recovery.js";
import { messageBlocksText } from "./run-replies.js";
import { reconcileStuckWork } from "./stuck-work.js";
import { isLoopGuardStopText } from "./tool-loop.js";
import { isUserProgressClientNonce } from "./user-progress.js";

const DEFAULT_INTERVAL_MS = 30_000;
/** The longest a pass waits while the database is unavailable. */
const MAX_OUTAGE_BACKOFF_MS = 2 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const ROUTINE_LOOKAHEAD_MS = 60_000;
const CONTROL_LOOKAHEAD_MS = 60_000;
/**
 * A queued run's job lock older than a run lease is abandoned. A live worker
 * finishing a failed attempt holds it for seconds before Graphile unlocks it.
 */
const ABANDONED_QUEUED_LOCK_MS = 5 * 60_000;
// Two keys give Rakazo's lock a namespace without relying on a hash that might collide
// with an application using the one-key advisory-lock API.
const RECONCILIATION_LOCK_NAMESPACE = 1_380_019_075;
const RECONCILIATION_LOCK_ID = 1;

type Cursor = { at: Date; id: string };
type ControlCursor = { at: Date | null; id: string };

export interface ReconciliationLeadership {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * Holds a session advisory lock for the lifetime of the elected reconciler. Followers
 * retry on every reconciliation interval, so a disconnected or stopped leader is
 * replaced without coordinating through application state.
 */
export function createPostgresReconciliationLeadership(
  pool: Pick<Pool, "connect">,
  options: { lockId?: number } = {},
): ReconciliationLeadership {
  const lockId = options.lockId ?? RECONCILIATION_LOCK_ID;
  let leaderClient: PoolClient | undefined;
  let leaderErrorListener: (() => void) | undefined;

  const loseClient = (client: PoolClient) => {
    if (leaderClient !== client) return;
    leaderClient = undefined;
    leaderErrorListener = undefined;
    client.release(true);
  };

  return {
    async tryAcquire() {
      if (leaderClient) return true;

      const candidate = await pool.connect();
      try {
        const result = await candidate.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        if (!result.rows[0]?.acquired) {
          candidate.release();
          return false;
        }

        leaderClient = candidate;
        leaderErrorListener = () => loseClient(candidate);
        candidate.once("error", leaderErrorListener);
        return true;
      } catch (error) {
        candidate.release(true);
        throw error;
      }
    },

    async release() {
      const client = leaderClient;
      if (!client) return;
      leaderClient = undefined;
      if (leaderErrorListener) client.removeListener("error", leaderErrorListener);
      leaderErrorListener = undefined;

      let destroy = false;
      try {
        const result = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS released",
          [RECONCILIATION_LOCK_NAMESPACE, lockId],
        );
        destroy = result.rows[0]?.released !== true;
      } catch {
        // Never return a connection with an uncertain session lock to the pool.
        destroy = true;
      } finally {
        client.release(destroy);
      }
    },
  };
}

export function createJobReconciler(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: ThreadEvents;
    notifications?: NotificationProvider;
    leadership?: ReconciliationLeadership;
    reconcileComputerUpdates?: () => Promise<void>;
    reconcileCloudAgents?: () => Promise<void>;
    reconcilePurchases?: () => Promise<void>;
    reconcileMediaVideos?: () => Promise<void>;
    reconcileModelCredits?: () => Promise<void>;
    reconcileRoutineRetryNotices?: () => Promise<void>;
    reconcileStrategicInitiatives?: () => Promise<void>;
    reconcileSecurityEventRetention?: () => Promise<void>;
    reconcileAuditLog?: () => Promise<void>;
    reconcileHomeStorage?: () => Promise<void>;
    reconcileIdleComputers?: () => Promise<void>;
    reconcileDeadJobs?: () => Promise<void>;
    /** Gives chat messages whose backup job was lost a new one. */
    reconcileChatDelivery?: () => Promise<void>;
    /** The process's database outage streak; defaults to the shared one. */
    outage?: DatabaseOutage;
  },
  options: { intervalMs?: number; batchSize?: number; maxPagesPerPass?: number } = {},
) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxPagesPerPass = options.maxPagesPerPass ?? 10;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Invalid batch size");
  if (!Number.isSafeInteger(maxPagesPerPass) || maxPagesPerPass < 1) {
    throw new Error("Invalid page budget");
  }
  const outage = deps.outage ?? databaseOutage;
  let outageFailures = 0;
  /** One log per outage for the whole process, instead of one per failing step and tick. */
  const report = (message: string, error: unknown) => {
    if (outage.failed(error, "job reconciliation")) outageFailures += 1;
    else getLogger().error(message, error);
  };
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciling: Promise<void> | undefined;
  let lastCompletedAt = Date.now();
  let stuckCursor: Cursor | undefined;
  let runCursor: Cursor | undefined;
  let routineCursor: Cursor | undefined;
  let controlCursor: ControlCursor | undefined;
  let controlScanDeadline: Date | undefined;
  // Housekeeping that waits on storage or another service runs beside the scans, never before
  // them, so a hung call cannot hold back recovery. Each skips a tick while its last pass runs.
  const housekeeping = [
    deps.reconcileCloudAgents,
    deps.reconcilePurchases,
    deps.reconcileMediaVideos,
    deps.reconcileModelCredits,
    deps.reconcileComputerUpdates,
    deps.reconcileRoutineRetryNotices,
    deps.reconcileStrategicInitiatives,
    deps.reconcileSecurityEventRetention,
    deps.reconcileAuditLog,
    deps.reconcileHomeStorage,
    deps.reconcileIdleComputers,
    deps.reconcileDeadJobs,
    deps.reconcileChatDelivery,
  ].filter((reconcile) => reconcile !== undefined);
  const housekeepingRunning = new Map<() => Promise<void>, Promise<void>>();
  const startHousekeeping = () => {
    for (const reconcile of housekeeping) {
      if (housekeepingRunning.has(reconcile)) continue;
      const pass = (async () => reconcile())()
        .catch((error) => report("auxiliary reconciliation", error))
        .finally(() => housekeepingRunning.delete(reconcile));
      housekeepingRunning.set(reconcile, pass);
    }
  };

  const reconcileOnce = async () => {
    if (reconciling) return reconciling;
    if (stopping) return;
    const failuresBefore = outageFailures;
    reconciling = (async () => {
      if (deps.leadership && !(await deps.leadership.tryAcquire())) return;

      startHousekeeping();
      const auxiliary = await Promise.allSettled([
        reconcileCallRequests(deps),
        reconcileComputerRuns(deps.prisma),
      ]);
      for (const result of auxiliary) {
        if (result.status === "rejected") report("auxiliary reconciliation", result.reason);
      }

      const now = new Date();
      try {
        stuckCursor = await reconcileStuckWork({
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          notifications: deps.notifications,
          now,
          batchSize,
          cursor: stuckCursor,
        });
      } catch (error) {
        report("stuck work reconciliation", error);
      }
      const runCursorFilter = runCursor
        ? {
            OR: [
              { updatedAt: { gt: runCursor.at } },
              { updatedAt: runCursor.at, id: { gt: runCursor.id } },
            ],
          }
        : undefined;
      const runs = await deps.prisma.run.findMany({
        where: {
          AND: [
            {
              OR: [
                { status: "queued" },
                {
                  status: { in: ["leased", "running"] },
                  leaseExpiresAt: { lte: now },
                },
              ],
            },
            ...(runCursorFilter ? [runCursorFilter] : []),
          ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: batchSize,
        select: {
          id: true,
          status: true,
          updatedAt: true,
          botId: true,
          trigger: true,
          bot: { select: { computerId: true } },
        },
      });

      const events = deps.events;
      if (events) {
        const outcomes = await deps.prisma.run.findMany({
          where: {
            trigger: "bot_message",
            botOutcomeReturnedAt: null,
            OR: [
              { status: { in: ["completed", "failed"] } },
              { status: "cancelled", error: { in: [...stuckWorkStatusMessages()] } },
            ],
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: {
            id: true,
            spaceId: true,
            threadId: true,
            botId: true,
            userId: true,
            sourceMessageId: true,
            status: true,
            error: true,
            bot: { select: { name: true } },
          },
        });
        await Promise.all(
          outcomes.map(async (run) => {
            const stuckCancel = run.status === "cancelled";
            const transcript =
              run.status === "failed" || stuckCancel
                ? { text: "", progressOnly: false }
                : await botRunOutcomeText(deps.prisma, run.id);
            const text = stuckCancel
              ? (run.error ?? "")
              : run.status === "failed"
                ? `Could not complete the delegated request: ${run.error ?? "unknown error"}`
                : transcript.text ||
                  "The delegated bot completed its turn without a written summary.";
            // Loop-guard stops complete without an error; their persisted final text
            // is the only marker available when the executor's outcome delivery fails.
            const loopGuardStop = isLoopGuardStopText(transcript.text);
            // Same stable delivery key as the executor path (auto-outcome:<runId>), so a
            // concurrent or earlier return is replayed instead of double-posted. Progress-only
            // transcripts (all mid-turn user-progress messages) return as status.
            const intent =
              run.status === "failed" ||
              stuckCancel ||
              !transcript.text.trim() ||
              transcript.progressOnly
                ? "status"
                : ("result" as const);
            const returned = await returnBotMessageOutcome(
              { prisma: deps.prisma, jobs: deps.jobs, events },
              run,
              { id: run.botId, name: run.bot.name },
              text,
              intent,
              { forceUnread: run.status === "failed" || stuckCancel || loopGuardStop },
            ).catch((error) => {
              report("bot message outcome reconciliation", error);
              return false;
            });
            if (!returned) {
              await deps.prisma.run.updateMany({
                where: { id: run.id, botOutcomeReturnedAt: null },
                data: { updatedAt: new Date() },
              });
            }
          }),
        );
        // A background helper whose result did not go back yet: a crash after it ended, or a
        // stop. A stopped helper only settles its card; anything else answers in the chat.
        const helpers = await deps.prisma.run.findMany({
          where: {
            trigger: BACKGROUND_HELPER_TRIGGER,
            status: { in: ["completed", "failed", "cancelled"] },
            botOutcomeReturnedAt: null,
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: batchSize,
          select: {
            id: true,
            spaceId: true,
            botId: true,
            userId: true,
            sourceMessageId: true,
            status: true,
            error: true,
          },
        });
        for (const run of helpers) {
          const expired =
            run.status === "cancelled" && stuckWorkStatusMessages().includes(run.error ?? "");
          await (async () => {
            const outcome =
              run.status === "completed"
                ? {
                    status: "completed" as const,
                    text: (await botRunOutcomeText(deps.prisma, run.id)).text,
                  }
                : run.status === "failed" || expired
                  ? { status: "failed" as const, text: run.error ?? "unknown error" }
                  : { status: "stopped" as const, text: "" };
            await returnHelperOutcome(
              { prisma: deps.prisma, jobs: deps.jobs, events },
              run,
              outcome,
            );
          })().catch(async (error) => {
            report("background helper outcome reconciliation", error);
            // Like a bot message outcome: retry later without holding the head of the queue.
            await deps.prisma.run.updateMany({
              where: { id: run.id, botOutcomeReturnedAt: null },
              data: { updatedAt: new Date() },
            });
          });
        }
      }

      // A queued run already has a job while it waits out failure backoff.
      // Default replace would zero that job's attempts and run it now. keepExisting
      // leaves the job while attempts remain, and still replaces one that is exhausted.
      // A locked job whose worker died is never unlocked, so it is replaced: any lock
      // for a run whose lease expired, and for a queued run only a lock older than
      // a lease, since a live worker finishing a failed attempt still holds it.
      const blockers = await findRunRecoveryBlockers(deps.prisma, runs, now);
      const abandonedQueuedLockAt = new Date(now.getTime() - ABANDONED_QUEUED_LOCK_MS);
      await publishAll([
        ...runs
          .filter((run) => !blockers.has(run.id))
          .map((run) =>
            deps.jobs.enqueue({
              ...runContinueJob(run.id),
              keepExisting: true,
              replaceLockedBefore: run.status === "queued" ? abandonedQueuedLockAt : now,
            }),
          ),
      ]);

      const lastRun = runs.at(-1);
      runCursor =
        runs.length === batchSize && lastRun
          ? { at: lastRun.updatedAt, id: lastRun.id }
          : undefined;

      // Scheduled work drains several pages per tick, yielding between pages.
      let routinesDone = false;
      let controlsDone = false;
      for (let page = 0; page < maxPagesPerPass; page += 1) {
        if (page > 0) await setImmediate();
        if (stopping) return;
        if (page > 0 && deps.leadership && !(await deps.leadership.tryAcquire())) return;
        controlScanDeadline ??= new Date(now.getTime() + CONTROL_LOOKAHEAD_MS);
        const routineCursorFilter = routineCursor
          ? {
              OR: [
                { nextRunAt: { gt: routineCursor.at } },
                { nextRunAt: routineCursor.at, id: { gt: routineCursor.id } },
              ],
            }
          : undefined;
        const controlCursorFilter = controlCursor
          ? controlCursor.at
            ? {
                OR: [
                  { controlLeaseExpiresAt: { gt: controlCursor.at } },
                  {
                    controlLeaseExpiresAt: controlCursor.at,
                    id: { gt: controlCursor.id },
                  },
                  { controlLeaseExpiresAt: null },
                ],
              }
            : { controlLeaseExpiresAt: null, id: { gt: controlCursor.id } }
          : undefined;
        // Annotated because the cursors carried across pages make inference circular.
        const [routines, controls]: [
          Array<{ id: string; nextRunAt: Date | null }>,
          Array<{
            id: string;
            controlBotId: string | null;
            controlLeaseId: string | null;
            controlLeaseExpiresAt: Date | null;
          }>,
        ] = await Promise.all([
          routinesDone
            ? []
            : deps.prisma.routine.findMany({
                where: {
                  AND: [
                    {
                      active: true,
                      nextRunAt: { lte: new Date(now.getTime() + ROUTINE_LOOKAHEAD_MS) },
                    },
                    ...(routineCursorFilter ? [routineCursorFilter] : []),
                  ],
                },
                orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
                take: batchSize,
                select: { id: true, nextRunAt: true },
              }),
          controlsDone
            ? []
            : deps.prisma.computer.findMany({
                where: {
                  AND: [
                    { controlLeaseId: { not: null } },
                    {
                      OR: [
                        { controlLeaseExpiresAt: null },
                        { controlLeaseExpiresAt: { lte: controlScanDeadline } },
                      ],
                    },
                    ...(controlCursorFilter ? [controlCursorFilter] : []),
                  ],
                },
                orderBy: [{ controlLeaseExpiresAt: "asc" }, { id: "asc" }],
                take: batchSize,
                select: {
                  id: true,
                  controlBotId: true,
                  controlLeaseId: true,
                  controlLeaseExpiresAt: true,
                },
              }),
        ]);
        await publishAll([
          ...routines.flatMap((routine) =>
            routine.nextRunAt
              ? [deps.jobs.enqueue(routineWakeupJob(routine.id, routine.nextRunAt))]
              : [],
          ),
          ...controls.flatMap((computer) =>
            computer.controlLeaseId
              ? [
                  scheduleComputerControlExpiry(
                    deps.jobs,
                    computer.id,
                    computer.controlLeaseId,
                    computer.controlLeaseExpiresAt ?? now,
                  ),
                ]
              : [],
          ),
        ]);

        const lastRoutine = routines.at(-1);
        routineCursor =
          routines.length === batchSize && lastRoutine?.nextRunAt
            ? { at: lastRoutine.nextRunAt, id: lastRoutine.id }
            : undefined;
        const lastControl = controls.at(-1);
        controlCursor =
          controls.length === batchSize && lastControl
            ? { at: lastControl.controlLeaseExpiresAt, id: lastControl.id }
            : undefined;
        if (!controlCursor) controlScanDeadline = undefined;
        routinesDone ||= !routineCursor;
        controlsDone ||= !controlCursor;
        if (routinesDone && controlsDone) break;
      }
    })()
      .then(() => {
        lastCompletedAt = Date.now();
        if (outageFailures === failuresBefore) outage.succeeded();
      })
      .finally(() => {
        reconciling = undefined;
      });
    return reconciling;
  };
  const reconcileSafely = () => {
    // While the database is unavailable each pass waits as long as the outage has lasted.
    if (!outage.ready(intervalMs, MAX_OUTAGE_BACKOFF_MS)) return;
    void reconcileOnce().catch((error) => report("background job reconciliation", error));
  };

  return {
    reconcileOnce,
    lastCompletedAt: () => lastCompletedAt,
    start() {
      if (timer) return;
      stopping = false;
      reconcileSafely();
      timer = setInterval(reconcileSafely, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await reconciling?.catch(() => undefined);
      // Read only after the pass settles: one waiting on leadership starts housekeeping late.
      await Promise.all(housekeepingRunning.values());
      await deps.leadership?.release();
    },
  };
}

/** Settles every publication before failing, so a retried page never overlaps one in flight. */
async function publishAll(publications: Array<Promise<unknown>>) {
  const failed = (await Promise.allSettled(publications)).find(
    (result) => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

/** Prefer the full bot transcript for a run so interim progress is not mistaken for the sole result. */
async function botRunOutcomeText(
  prisma: {
    message: {
      findMany: (args: {
        where: { runId: string; role: "bot" };
        orderBy: { seq: "asc" };
        select: { blocks: true; clientNonce: true };
      }) => Promise<Array<{ blocks: unknown; clientNonce: string | null }>>;
    };
  },
  runId: string,
): Promise<{ text: string; progressOnly: boolean }> {
  const messages = await prisma.message.findMany({
    where: { runId, role: "bot" },
    orderBy: { seq: "asc" },
    select: { blocks: true, clientNonce: true },
  });
  const progressParts: string[] = [];
  const finalParts: string[] = [];
  for (const message of messages) {
    const text = messageText(message.blocks);
    if (!text) continue;
    if (isUserProgressClientNonce(message.clientNonce)) progressParts.push(text);
    else finalParts.push(text);
  }
  // Prefer the latest non-progress reply when present so earlier untagged mid-run
  // publishes (for example pre-takeover narration) do not contaminate the result.
  // Progress-only turns still join progress beats as status.
  if (finalParts.length > 0) {
    return { text: finalParts[finalParts.length - 1]!, progressOnly: false };
  }
  return { text: progressParts.join("\n\n"), progressOnly: progressParts.length > 0 };
}

function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return messageBlocksText(blocks as MessageBlock[]).trim();
}
