import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * How a computer run ended.
 * - `stopped`: stopped on request (the stop button, a computer switch, an archived bot).
 * - `idle` / `active_limit`: idle shutdown, or the cap on one continuous stretch.
 * - `allowance`: its organization spent this billing period's computer allowance.
 * - `replaced`: torn down by update, recovery or reset; the replacement starts a new run.
 * - `gone`: the provider had already stopped or lost the sandbox.
 * - `deleted`: destroyed with its computer, bot, space or account.
 * - `reconciled`: the end was never seen; a later start or the reconciler found the computer
 *   no longer running.
 *
 * A `gone` or `reconciled` end, noticed only later, is the run's `lastSeenAt` when there is one,
 * else when it was noticed.
 */
export type ComputerRunEnd =
  | "stopped"
  | "idle"
  | "active_limit"
  | "allowance"
  | "replaced"
  | "gone"
  | "deleted"
  | "reconciled";

type RunsClient = Pick<PrismaClient, "computerRun" | "$executeRaw">;

/**
 * Records the run that began at the computer's `runningSince`, and closes an earlier run whose
 * end was missed with `previousEnd`. Idempotent: a reconnect within the same stretch is a no-op.
 * Usage recording never fails the lifecycle transition that calls it.
 */
export async function recordComputerRunStart(
  prisma: RunsClient,
  computer: {
    id: string;
    spaceId: string;
    userId: string;
    kind: string;
    providerRef: string | null;
  },
  startedAt: Date,
  previousEnd: ComputerRunEnd = "reconciled",
): Promise<void> {
  // Host computers run on the user's own machine, and Electron, not Rakazo, sees them stop.
  if (computer.kind === "desktop") return;
  try {
    await prisma.$executeRaw`
      UPDATE "computer_runs"
      SET "endedAt" = COALESCE("lastSeenAt", ${startedAt}::timestamp(3)), "endReason" = ${previousEnd}
      WHERE "computerId" = ${computer.id} AND "endedAt" IS NULL
        AND "startedAt" < ${startedAt}::timestamp(3)`;
    await prisma.computerRun.createMany({
      data: [
        {
          computerId: computer.id,
          spaceId: computer.spaceId,
          userId: computer.userId,
          kind: computer.kind,
          providerRef: computer.providerRef,
          startedAt,
        },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    getLogger().error("computer.run_record_failed", error, {
      "computer.id": computer.id,
      transition: "start",
    });
  }
  await recordComputerRunSeen(prisma, { id: computer.id, runningSince: startedAt });
}

/**
 * Notes that the stretch that began at `runningSince` was just seen running, so an end noticed
 * only later is placed here rather than at the moment it was noticed. Never fails its caller.
 */
export async function recordComputerRunSeen(
  prisma: RunsClient,
  computer: { id: string; runningSince?: Date | null },
): Promise<void> {
  if (!computer.runningSince) return;
  try {
    await prisma.computerRun.updateMany({
      where: { computerId: computer.id, startedAt: computer.runningSince, endedAt: null },
      data: { lastSeenAt: new Date() },
    });
  } catch (error) {
    getLogger().error("computer.run_record_failed", error, {
      "computer.id": computer.id,
      transition: "seen",
    });
  }
}

/**
 * Closes the run of the stretch that began at `runningSince`, read before the stop. A restart
 * that lands before this write opens a run with a newer start, which stays open. Without a
 * start (deletion, or a row an older release activated) it closes every open run. Never fails
 * the transition that calls it.
 */
export async function recordComputerRunEnd(
  prisma: RunsClient,
  computer: { id: string; runningSince?: Date | null },
  reason: ComputerRunEnd,
): Promise<void> {
  const endedAt = new Date();
  try {
    if (reason === "gone") {
      const runningSince = computer.runningSince ?? null;
      await prisma.$executeRaw`
        UPDATE "computer_runs"
        SET "endedAt" = COALESCE("lastSeenAt", ${endedAt}::timestamp(3)), "endReason" = ${reason}
        WHERE "computerId" = ${computer.id} AND "endedAt" IS NULL
          AND CASE WHEN ${runningSince}::timestamp(3) IS NULL
            THEN "startedAt" <= ${endedAt}::timestamp(3)
            ELSE "startedAt" = ${runningSince}::timestamp(3) END`;
      return;
    }
    await prisma.computerRun.updateMany({
      where: {
        computerId: computer.id,
        endedAt: null,
        startedAt: computer.runningSince ?? { lte: endedAt },
      },
      data: { endedAt, endReason: reason },
    });
  } catch (error) {
    getLogger().error("computer.run_record_failed", error, {
      "computer.id": computer.id,
      transition: "end",
      reason,
    });
  }
}

/**
 * Repairs what the lifecycle did not record. Closes open runs whose computer row is gone, is no
 * longer running, or has begun a newer stretch, and opens the run of a running computer that
 * has none. Covers a crash or deploy between a provider call and its usage write, a failed
 * usage write, and paths that stop a computer without recording it.
 */
export async function reconcileComputerRuns(
  prisma: Pick<PrismaClient, "$executeRaw">,
  now = new Date(),
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "computer_runs" AS r
    SET "endedAt" = CASE WHEN c."id" IS NULL THEN ${now}::timestamp(3)
          ELSE GREATEST(COALESCE(r."lastSeenAt", ${now}::timestamp(3)), r."startedAt") END,
        "endReason" = CASE WHEN c."id" IS NULL THEN 'deleted' ELSE 'reconciled' END
    FROM "computer_runs" AS o
    LEFT JOIN "computers" AS c ON c."id" = o."computerId"
    WHERE r."id" = o."id"
      AND o."endedAt" IS NULL
      AND (
        c."id" IS NULL
        OR c."state" NOT IN ('running', 'booting', 'suspending')
        OR c."runningSince" IS DISTINCT FROM o."startedAt"
      )`;
  // A booting computer may still carry the start of its previous stretch, so only rows that
  // finished starting count. The start is the one time it was seen; this pass reads only the row. Host computers are never recorded (see recordComputerRunStart).
  await prisma.$executeRaw`
    INSERT INTO "computer_runs" ("id", "computerId", "spaceId", "userId", "kind", "providerRef", "startedAt", "lastSeenAt")
    SELECT gen_random_uuid()::text, c."id", c."spaceId", c."userId", c."kind", c."providerRef", c."runningSince", c."runningSince"
    FROM "computers" AS c
    WHERE c."state" IN ('running', 'suspending')
      AND c."runningSince" IS NOT NULL
      AND c."kind" <> 'desktop'
      AND NOT EXISTS (
        SELECT 1 FROM "computer_runs" AS r
        WHERE r."computerId" = c."id" AND r."startedAt" = c."runningSince"
      )
    ON CONFLICT ("computerId", "startedAt") DO NOTHING`;
}
