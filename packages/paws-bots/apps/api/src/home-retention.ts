import { randomUUID } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { HomeDeletionReason } from "@rakazo/auth";
import { emailLocale, homeDeletionEmail } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { hasModelAccess, needsBillingPortal, Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_ENDED_DAYS = 30;
const UNUSED_DAYS = 90;
const WARNING_DAYS = 7;
const CLAIM_MS = 15 * 60 * 1000;
const BATCH = 500;
/** Cleared only while nothing runs on it; a failed start leaves `error`, which nothing moves on. */
const IDLE_STATES = ["stopped", "suspended", "error"];
const NO_CREDITS = { mode: null, balanceMicros: 0n, byokFreeUntil: null };

type Account = {
  billing: {
    status: string | null;
    paidAt: Date | null;
    endedAt: Date | null;
    currentPeriodEndsAt: Date | null;
    updatedAt: Date;
  } | null;
  modelCredits: {
    mode: string | null;
    balanceMicros: bigint;
    byokFreeUntil: Date | null;
    /** The latest purchase or grant only. */
    lots: Array<{ createdAt: Date }>;
  } | null;
};
type Due = { at: Date; reason: HomeDeletionReason };
type Db = PrismaClient | Prisma.TransactionClient;
type Warning = { organizationId: string; reason: HomeDeletionReason; ids: string[] };

/**
 * When a computer's saved home becomes due for deletion: 30 days after a paid plan ended, or
 * 90 days unused without one (a trial that never paid counts as none). Use since then moves it
 * later, and so does buying credits, even ones spent before the next sweep. Null while the
 * organization can run bots (a plan, credits or a free period) or owes a payment.
 */
export function homeDeletionDue(account: Account, lastUsedAt: Date, now = new Date()): Due | null {
  if (planIsLive(account, now)) return null;
  const { billing, modelCredits } = account;
  const credited = modelCredits?.lots[0]?.createdAt;
  const since = credited ? latest(credited, lastUsedAt) : lastUsedAt;
  if (billing?.paidAt) {
    const ended = billing.endedAt ?? billing.currentPeriodEndsAt ?? billing.updatedAt;
    return { at: addDays(latest(ended, since), PLAN_ENDED_DAYS), reason: "plan-ended" };
  }
  return { at: addDays(since, UNUSED_DAYS), reason: "unused" };
}

function planIsLive({ billing, modelCredits }: Account, now: Date) {
  const status = billing?.status ?? null;
  return needsBillingPortal(status) || hasModelAccess(modelCredits ?? NO_CREDITS, status, now);
}

const candidate = {
  homeStorageId: { not: null },
  // These work in a copy on a host the user or the server runs; the stored home only backs it up.
  kind: { notIn: ["docker", "desktop", "wuying"] },
} satisfies Prisma.ComputerWhereInput;

interface HomeRetentionDeps {
  prisma: PrismaClient;
  email: TransactionalEmailProvider;
  appUrl: string;
  onError: (error: unknown) => void;
}

/**
 * Deletes stored homes that are past retention, emailing each organization's owner a week
 * first. Every API instance may run it: a claim keeps each email to one process, and eligibility
 * is read again right before each email and inside the deletion's transaction, so resubscribing
 * or using a bot in the meantime cancels it.
 *
 * Deleting clears the computer's pointer to its stored home and the key that decrypts it; the
 * worker's storage sweep then removes the unowned objects. The computer row and its provider
 * reference stay, so a provider that keeps its own disk resumes it; any other computer, or one
 * whose provider copy has expired, starts empty next time. Docker, desktop and Wuying computers
 * are skipped: they work in a copy on a host, which the stored home backs up. Aborting stops it
 * between emails and deletions; the next sweep picks up the rest.
 */
export function homeRetentionSweep(
  deps: HomeRetentionDeps,
): (signal: AbortSignal) => Promise<void> {
  return (signal) =>
    runAsSystem("delete saved homes past retention", async () => {
      const { prisma } = deps;
      await prisma.homeDeletionNotice.deleteMany({
        where: { computer: { NOT: candidate }, ...claimable() },
      });
      const warnings = new Map<string, Warning>();
      let cursor: string | undefined;
      while (!signal.aborted) {
        const now = new Date();
        const computers = await dueDates(prisma, {}, now, cursor);
        for (const { id, organizationId, notice, due } of computers) {
          // The deletion keeps the date the email gave, unless something since moved it later.
          if (notice?.warnedAt && notice.deleteAfter && due && due.at <= notice.deleteAfter) {
            if (notice.deleteAfter <= now && !signal.aborted)
              await removeHome(prisma, id).catch(deps.onError);
            continue;
          }
          const warnable = due && due.at.getTime() <= now.getTime() + WARNING_DAYS * DAY_MS;
          // A claimed notice is another process's email in progress.
          if (notice && (notice.warnedAt || !warnable))
            await prisma.homeDeletionNotice.deleteMany({
              where: { computerId: id, ...claimable() },
            });
          if (!warnable) continue;
          const key = `${organizationId}:${due.reason}`;
          const group = warnings.get(key) ?? { organizationId, reason: due.reason, ids: [] };
          group.ids.push(id);
          warnings.set(key, group);
        }
        if (computers.length < BATCH) break;
        cursor = computers.at(-1)?.id;
      }
      // One at a time: a burst would trip the email provider's rate limit.
      for (const group of warnings.values()) {
        if (signal.aborted) return;
        await warn(deps, group).catch(deps.onError);
      }
    });
}

/**
 * Each matching computer with a stored home and the date it is due for deletion now. A computer
 * that is running or starting counts as used now.
 */
async function dueDates(db: Db, where: Prisma.ComputerWhereInput, now: Date, cursor?: string) {
  const computers = await db.computer.findMany({
    // Paging by id, not a Prisma cursor: a computer cleared on this page no longer matches, and a
    // cursor's skip would then pass over the next one.
    where: { AND: [where, candidate, cursor ? { id: { gt: cursor } } : {}] },
    select: {
      id: true,
      state: true,
      space: {
        select: {
          organizationId: true,
          organization: {
            select: {
              billing: {
                select: {
                  status: true,
                  paidAt: true,
                  endedAt: true,
                  currentPeriodEndsAt: true,
                  updatedAt: true,
                },
              },
              modelCredits: {
                select: {
                  mode: true,
                  balanceMicros: true,
                  byokFreeUntil: true,
                  lots: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
                },
              },
            },
          },
        },
      },
      homeDeletionNotice: { select: { warnedAt: true, deleteAfter: true } },
    },
    orderBy: { id: "asc" },
    take: BATCH,
  });
  // Only computers that could be due need their history read.
  const used = await lastUsed(
    db,
    computers
      .filter(
        (computer) =>
          IDLE_STATES.includes(computer.state) && !planIsLive(computer.space.organization, now),
      )
      .map((computer) => computer.id),
  );
  return computers.map((computer) => {
    const usedAt = used.get(computer.id);
    return {
      id: computer.id,
      organizationId: computer.space.organizationId,
      notice: computer.homeDeletionNotice,
      due: usedAt ? homeDeletionDue(computer.space.organization, usedAt, now) : null,
    };
  });
}

/**
 * The latest of each computer's creation, its last save, its bots' latest runs, and its latest
 * running stretch.
 * Each lookup reads one index entry, so the cost does not grow with run history.
 */
async function lastUsed(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, Date>();
  const rows = await db.$queryRaw<Array<{ id: string; at: Date }>>`
    SELECT c.id, GREATEST(
      c."createdAt",
      c."homeRevisionAt",
      (SELECT max((SELECT max(r."createdAt") FROM runs r WHERE r."botId" = b.id))
        FROM bots b WHERE b."computerId" = c.id),
      (SELECT GREATEST(s."startedAt", s."endedAt", s."lastSeenAt") FROM computer_runs s
        WHERE s."computerId" = c.id ORDER BY s."startedAt" DESC LIMIT 1)
    ) AS at
    FROM computers c WHERE c.id IN (${Prisma.join(ids)})`;
  return new Map(rows.map((row) => [row.id, row.at]));
}

function claimable() {
  return { OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: new Date() } }] };
}

/**
 * The date a warning sent at `sentAt` names, and when deletion may start: once that date has
 * ended in every time zone.
 */
export function deletionDates(sentAt: Date) {
  const shown = new Date(addDays(sentAt, WARNING_DAYS).setUTCHours(0, 0, 0, 0));
  return { shown, deleteAfter: addDays(shown, 2) };
}

/**
 * Emails the organization's first owner, the one who can pay, once for all its computers still
 * due for the same reason. A crash after sending
 * and before recording it sends again once the claim expires, so nothing is deleted unwarned.
 */
async function warn(deps: HomeRetentionDeps, group: Warning) {
  const { prisma } = deps;
  await prisma.homeDeletionNotice.createMany({
    data: group.ids.map((computerId) => ({ computerId })),
    skipDuplicates: true,
  });
  const claimId = randomUUID();
  const claimed = await prisma.homeDeletionNotice.updateMany({
    where: { computerId: { in: group.ids }, warnedAt: null, ...claimable() },
    data: { claimId, claimExpiresAt: new Date(Date.now() + CLAIM_MS) },
  });
  if (!claimed.count) return;
  const release = () =>
    prisma.homeDeletionNotice.updateMany({
      where: { claimId },
      data: { claimId: null, claimExpiresAt: null },
    });
  try {
    // Read again now that the claim holds them: a plan or use since the scan cancels.
    const sentAt = new Date();
    const { shown, deleteAfter } = deletionDates(sentAt);
    const due: string[] = [];
    for (let cursor: string | undefined; ; ) {
      const page = await dueDates(prisma, { homeDeletionNotice: { claimId } }, sentAt, cursor);
      for (const computer of page)
        if (computer.due?.reason === group.reason && computer.due.at <= deleteAfter)
          due.push(computer.id);
      if (page.length < BATCH) break;
      cursor = page.at(-1)?.id;
    }
    await prisma.homeDeletionNotice.deleteMany({ where: { claimId, computerId: { notIn: due } } });
    const owner = due.length
      ? await prisma.member.findFirst({
          where: { organizationId: group.organizationId, role: { contains: "owner" } },
          orderBy: { createdAt: "asc" },
          select: { user: { select: { email: true, name: true, locale: true } } },
        })
      : null;
    const user = owner?.user;
    if (!user) {
      if (due.length)
        getLogger().warn("home.retention.no_recipient", {
          "organization.id": group.organizationId,
          "home.retention.reason": group.reason,
          "home.retention.computers": due.length,
        });
      await release();
      return;
    }
    await deps.email.send(
      await homeDeletionEmail(user, shown, group.reason, deps.appUrl, emailLocale(user.locale)),
    );
    await prisma.homeDeletionNotice.updateMany({
      where: { claimId },
      data: { warnedAt: sentAt, deleteAfter, claimId: null, claimExpiresAt: null },
    });
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Clears the computer's stored home in one transaction that locks the computer and its notice
 * and reads eligibility again, so a start, a run or a plan that lands first cancels it. It also
 * locks the organization's billing and credit rows, and the organization row itself, which a new
 * billing or credit account's foreign key check waits on, so a payment either lands before the
 * read or waits for the deletion to commit.
 */
async function removeHome(prisma: PrismaClient, computerId: string) {
  const removed = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ organizationId: string }>>`
      SELECT s."organizationId" FROM computers c
      JOIN home_deletion_notices n ON n."computerId" = c.id
      JOIN spaces s ON s.id = c."spaceId"
      WHERE c.id = ${computerId} FOR UPDATE OF c, n`;
    if (!locked) return false;
    const { organizationId } = locked;
    await tx.$queryRaw`SELECT id FROM organization WHERE id = ${organizationId} FOR UPDATE`;
    await tx.$queryRaw`
      SELECT "organizationId" FROM billing_accounts WHERE "organizationId" = ${organizationId}
      FOR SHARE`;
    await tx.$queryRaw`
      SELECT "organizationId" FROM model_credit_accounts
      WHERE "organizationId" = ${organizationId} FOR SHARE`;
    const now = new Date();
    const [computer] = await dueDates(
      tx,
      { id: computerId, state: { in: IDLE_STATES }, maintenanceId: null },
      now,
    );
    const notice = computer?.notice;
    if (
      !computer?.due ||
      !notice?.warnedAt ||
      !notice.deleteAfter ||
      notice.deleteAfter > now ||
      computer.due.at > notice.deleteAfter
    )
      return false;
    await tx.computer.update({
      where: { id: computerId },
      data: {
        homeStorageId: null,
        homeStorageKey: null,
        homeStorageRevision: null,
        homeRevision: "empty",
        homeRevisionAt: null,
      },
    });
    await tx.homeDeletionNotice.delete({ where: { computerId } });
    return true;
  });
  if (removed) getLogger().info("home.retention.deleted", { "computer.id": computerId });
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function latest(a: Date, b: Date) {
  return a > b ? a : b;
}
