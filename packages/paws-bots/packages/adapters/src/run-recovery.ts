import { BACKGROUND_HELPER_TRIGGER, isTerminal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { expireComputerExecutionLeases } from "@rakazo/db";
import { EXECUTION_LEASE_MS } from "./computer-lifecycle.js";

type RecoveryRun = {
  id: string;
  botId: string;
  trigger: string;
  bot: { computerId: string | null };
};

/**
 * Leave resource waits untouched so recovery preserves their age and execution history.
 * A takeover hold whose run ended or was deleted is expired instead: leases have no relation
 * to runs, so nothing else would free the bot's computer before the hold lapses a day later.
 */
export async function findRunRecoveryBlockers(
  prisma: PrismaClient,
  runs: readonly RecoveryRun[],
  now: Date,
): Promise<Map<string, string>> {
  const leases = runs.length
    ? await prisma.computerExecutionLease.findMany({
        where: { botId: { in: runs.map((run) => run.botId) }, expiresAt: { gt: now } },
        select: { computerId: true, botId: true, runId: true, expiresAt: true },
      })
    : [];
  const abandoned = await findAbandonedTakeoverHolds(prisma, leases, now);
  if (abandoned.size) {
    // Expire as a tombstone, like a release, so the next run's lease fence still rises.
    await expireComputerExecutionLeases(prisma, {
      runId: { in: [...abandoned] },
      expiresAt: { gt: now },
    });
  }
  const blockers = new Map<string, string>();
  for (const run of runs) {
    // A background helper never takes the computer, so the bot's own turn does not hold it.
    if (run.trigger === BACKGROUND_HELPER_TRIGGER) continue;
    const lease = leases.find(
      (lease) =>
        lease.botId === run.botId &&
        lease.computerId === run.bot.computerId &&
        lease.runId !== run.id &&
        !abandoned.has(lease.runId),
    );
    if (lease) blockers.set(run.id, lease.runId);
  }
  return blockers;
}

/**
 * A run lease reaches at most one lease length past its last renewal, and computer operations
 * hold leases under ids that are not runs, so only a lease reaching further is a takeover hold.
 * The margin covers clock skew between hosts.
 */
async function findAbandonedTakeoverHolds(
  prisma: PrismaClient,
  leases: ReadonlyArray<{ runId: string; expiresAt: Date }>,
  now: Date,
): Promise<Set<string>> {
  const holdAfter = now.getTime() + 2 * EXECUTION_LEASE_MS;
  const holders = leases
    .filter((lease) => lease.expiresAt.getTime() > holdAfter)
    .map((lease) => lease.runId);
  if (holders.length === 0) return new Set();
  const live = await prisma.run.findMany({
    where: { id: { in: holders } },
    select: { id: true, status: true },
  });
  const liveIds = new Set(live.filter((run) => !isTerminal(run.status)).map((run) => run.id));
  return new Set(holders.filter((runId) => !liveIds.has(runId)));
}
