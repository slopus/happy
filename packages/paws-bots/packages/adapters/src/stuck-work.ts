import type { JobPublisher, NotificationMessage, NotificationProvider } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { StuckWorkStatus } from "@rakazo/core";
import {
  isStuckWorkStatus,
  STUCK_WORK_NOTICE,
  STUCK_WORK_STATUSES,
  stuckWorkAction,
  stuckWorkAgeMs,
  stuckWorkDueAfterMs,
  stuckWorkReminder,
  stuckWorkStoppedNotification,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  expireStuckRun,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ExpoPushProvider } from "./expo-push.js";
import { notificationIdentity } from "./notification-identity.js";
import { publishChatAlert } from "./run-notifications.js";

type StuckCursor = { at: Date; id: string };

type StuckCandidate = {
  id: string;
  status: StuckWorkStatus;
  updatedAt: Date;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  taskId: string;
  bot: { name: string; color: string; avatarSet: string; notifyOnFinish: boolean };
  thread: { groupId: string | null };
};

/**
 * How long a pending reminder claim counts as in flight. Longer than the Expo
 * push timeout so a live send is not treated as abandoned, and short enough
 * that a worker which stops before Expo accepts the push is retried.
 */
export const STUCK_NOTICE_CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Remind, then cancel, queued runs and human waits that have been sitting still. The notice
 * stamp is keyed to this episode's updatedAt, so answering or reclaiming the run can remind
 * again later. A pending claim becomes delivered only after the push is accepted and is removed
 * when the push fails, so a crash or a dropped token can still remind.
 */
export async function reconcileStuckWork(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: ThreadEvents;
  notifications?: NotificationProvider;
  now: Date;
  batchSize: number;
  cursor?: StuckCursor;
}): Promise<StuckCursor | undefined> {
  const cursorFilter = deps.cursor
    ? {
        OR: [
          { updatedAt: { gt: deps.cursor.at } },
          { updatedAt: deps.cursor.at, id: { gt: deps.cursor.id } },
        ],
      }
    : undefined;
  const runs = await deps.prisma.run.findMany({
    where: {
      AND: [
        {
          OR: STUCK_WORK_STATUSES.map((status) => ({
            status,
            updatedAt: { lte: new Date(deps.now.getTime() - stuckWorkDueAfterMs(status)) },
          })),
        },
        ...(cursorFilter ? [cursorFilter] : []),
      ],
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: deps.batchSize,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      taskId: true,
      bot: { select: { name: true, color: true, avatarSet: true, notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });

  const due = runs.flatMap((run) => {
    const candidate = readyStuckRun(run, deps.now);
    return candidate ? [candidate] : [];
  });
  const notices = due.length
    ? await deps.prisma.event.findMany({
        where: {
          runId: { in: due.map((run) => run.id) },
          type: "thread.meta",
          payload: { path: ["notice"], equals: STUCK_WORK_NOTICE },
        },
        select: { runId: true, payload: true },
      })
    : [];

  for (const run of due) {
    const alreadyNotified = notices.some(
      (notice) => notice.runId === run.id && noticeIsDelivered(notice.payload, run.updatedAt),
    );
    const action = stuckWorkAction({
      status: run.status,
      ageMs: stuckWorkAgeMs(run.updatedAt, deps.now),
      alreadyNotified,
    });
    try {
      if (action === "notify") await remindStuckRun(deps, run);
      else if (action === "expire") await expireOne(deps, run);
    } catch (error) {
      getLogger().error("stuck work", error);
    }
  }

  const last = runs.at(-1);
  if (runs.length < deps.batchSize || !last || !(last.updatedAt instanceof Date)) return undefined;
  return { at: last.updatedAt, id: last.id };
}

function readyStuckRun(
  run: Omit<Partial<StuckCandidate>, "status"> & { id: string; status?: string },
  now: Date,
): StuckCandidate | null {
  if (!run.status || !isStuckWorkStatus(run.status)) return null;
  if (!(run.updatedAt instanceof Date)) return null;
  if (stuckWorkAgeMs(run.updatedAt, now) < stuckWorkDueAfterMs(run.status)) return null;
  if (!run.spaceId || !run.threadId || !run.botId || !run.userId || !run.taskId) return null;
  if (!run.bot || !run.thread) return null;
  return {
    id: run.id,
    status: run.status,
    updatedAt: run.updatedAt,
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    taskId: run.taskId,
    bot: run.bot,
    thread: run.thread,
  };
}

function noticesEnabled(run: StuckCandidate): boolean {
  return Boolean(run.thread.groupId || run.bot.notifyOnFinish);
}

type StuckNoticePayload = {
  notice?: unknown;
  updatedAt?: unknown;
  state?: unknown;
  claimedAt?: unknown;
};

function stuckNoticePayload(payload: unknown): StuckNoticePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as StuckNoticePayload;
  if (record.notice !== STUCK_WORK_NOTICE || typeof record.updatedAt !== "string") return null;
  return record;
}

/** A stamp counts as delivered once the push was accepted. Pending claims do not. */
function noticeIsDelivered(payload: unknown, updatedAt: Date): boolean {
  const record = stuckNoticePayload(payload);
  if (!record || record.updatedAt !== updatedAt.toISOString()) return false;
  return record.state !== "pending";
}

function pendingClaimFresh(payload: unknown, updatedAt: Date, now: Date): boolean {
  const record = stuckNoticePayload(payload);
  if (!record) return false;
  if (record.state !== "pending" || record.updatedAt !== updatedAt.toISOString()) return false;
  if (typeof record.claimedAt !== "string") return false;
  const claimedAt = Date.parse(record.claimedAt);
  if (!Number.isFinite(claimedAt)) return false;
  const age = now.getTime() - claimedAt;
  return age >= 0 && age < STUCK_NOTICE_CLAIM_TTL_MS;
}

function deliveredNotice(run: StuckCandidate): Prisma.InputJsonValue {
  return {
    notice: STUCK_WORK_NOTICE,
    updatedAt: run.updatedAt.toISOString(),
    state: "delivered",
  };
}

async function remindStuckRun(
  deps: {
    prisma: PrismaClient;
    events?: ThreadEvents;
    notifications?: NotificationProvider;
    now: Date;
  },
  run: StuckCandidate,
) {
  // A skipped push (notices off, no provider, or no push token yet) stays unmarked
  // so a later sweep can still remind during this same wait.
  if (!deps.notifications || !noticesEnabled(run)) return;
  if (!(await pushCanDeliver(deps.notifications, run.userId))) return;
  const claimId = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      (tx) => claimStuckReminder(tx, run, deps.now),
      THREAD_LOCK_TRANSACTION_OPTIONS,
    ),
  );
  if (!claimId) return;
  const reminder = stuckWorkReminder(run.status, run.bot.name);
  const message = {
    kind: reminder.kind,
    title: reminder.title,
    body: reminder.body,
    botId: run.botId,
    threadId: run.threadId,
  };
  const delivery = await sendStuckNotice(deps.notifications, run, message);
  if (delivery === "delivered") {
    // After the push, so a failed push that is retried does not alert open apps twice.
    publishChatAlert(deps.events, run, message, run.thread.groupId);
    await withTransactionRetry(() =>
      deps.prisma.$transaction(
        (tx) => markStuckNoticeDelivered(tx, claimId, run),
        THREAD_LOCK_TRANSACTION_OPTIONS,
      ),
    );
    return;
  }
  await withTransactionRetry(() => deps.prisma.$transaction((tx) => clearStuckNotice(tx, claimId)));
}

async function pushCanDeliver(
  notifications: NotificationProvider,
  userId: string,
): Promise<boolean> {
  if (!(notifications instanceof ExpoPushProvider)) return true;
  return notifications.hasPushRecipient(userId);
}

async function claimStuckReminder(
  tx: Prisma.TransactionClient,
  run: StuckCandidate,
  now: Date,
): Promise<string | null> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  const current = await tx.run.findUnique({
    where: { id: run.id },
    select: { status: true, updatedAt: true },
  });
  if (
    !current ||
    current.status !== run.status ||
    current.updatedAt.getTime() !== run.updatedAt.getTime()
  ) {
    return null;
  }
  const existing = await tx.event.findMany({
    where: {
      runId: run.id,
      type: "thread.meta",
      payload: { path: ["notice"], equals: STUCK_WORK_NOTICE },
    },
    select: { payload: true },
  });
  if (existing.some((notice) => noticeIsDelivered(notice.payload, current.updatedAt))) return null;
  if (existing.some((notice) => pendingClaimFresh(notice.payload, current.updatedAt, now))) {
    return null;
  }
  await tx.event.deleteMany({
    where: {
      runId: run.id,
      type: "thread.meta",
      AND: [
        { payload: { path: ["notice"], equals: STUCK_WORK_NOTICE } },
        { payload: { path: ["updatedAt"], equals: current.updatedAt.toISOString() } },
        { payload: { path: ["state"], equals: "pending" } },
      ],
    },
  });
  const claimed = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.meta",
    runId: run.id,
    payload: {
      notice: STUCK_WORK_NOTICE,
      updatedAt: current.updatedAt.toISOString(),
      state: "pending",
      claimedAt: now.toISOString(),
    },
  });
  return claimed.id;
}

async function markStuckNoticeDelivered(
  tx: Prisma.TransactionClient,
  eventId: string,
  run: StuckCandidate,
) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  await tx.event.update({
    where: { id: eventId },
    data: { payload: deliveredNotice(run) },
  });
}

async function clearStuckNotice(tx: Prisma.TransactionClient, eventId: string) {
  await tx.event.deleteMany({ where: { id: eventId } });
}

async function expireOne(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: ThreadEvents;
    notifications?: NotificationProvider;
    now: Date;
  },
  run: StuckCandidate,
) {
  const expired = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      (tx) =>
        expireStuckRun(tx, {
          runId: run.id,
          threadId: run.threadId,
          status: run.status,
          updatedAt: run.updatedAt,
          now: deps.now,
        }),
      THREAD_LOCK_TRANSACTION_OPTIONS,
    ),
  );
  if (!expired) return;
  await deps.events?.notify(run.threadId, expired.seq).catch((error) => {
    getLogger().error("stuck work realtime notification", error);
  });
  if (expired.continuationRunId) {
    await deps.jobs.enqueue(runContinueJob(expired.continuationRunId)).catch((error) => {
      getLogger().error("stuck work continuation", error);
    });
  }
  if (!noticesEnabled(run)) return;
  const stopped = stuckWorkStoppedNotification(run.status, run.bot.name);
  const message = {
    kind: stopped.kind,
    title: stopped.title,
    body: stopped.body,
    botId: run.botId,
    threadId: run.threadId,
  };
  publishChatAlert(deps.events, run, message, run.thread.groupId);
  if (deps.notifications) await sendStuckNotice(deps.notifications, run, message);
}

type StuckNoticeDelivery = "delivered" | "undeliverable" | "failed";

async function sendStuckNotice(
  notifications: NotificationProvider,
  run: StuckCandidate,
  message: NotificationMessage,
): Promise<StuckNoticeDelivery> {
  const context = {
    operationId: "notify",
    traceId: run.botId,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal: new AbortController().signal,
  };
  try {
    const notice = {
      ...message,
      sender: await notificationIdentity({ id: run.botId, ...run.bot }),
      ...(run.thread.groupId ? { groupId: run.thread.groupId } : {}),
    };
    if (notifications instanceof ExpoPushProvider) {
      return await notifications.deliver(notice, context);
    }
    await notifications.send(notice, context);
    return "delivered";
  } catch (error) {
    getLogger().error("stuck work notification", error);
    return "failed";
  }
}
