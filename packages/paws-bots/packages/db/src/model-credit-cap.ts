import { randomUUID } from "node:crypto";
import { MODEL_CREDIT_CAP_REACHED_ERROR } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import { runAsSystemInTransaction } from "./row-security.js";

/** Attributed credit deltas include holds and survive deletion. Legacy baselines cannot
 * distinguish hosted spend from personal-key usage, so they cannot be assigned to a user. */
async function committedModelCredits(tx: Prisma.TransactionClient, userId: string) {
  const [row] = await tx.$queryRaw<{ micros: bigint }[]>`
    SELECT COALESCE(-SUM("amountMicros"), 0)::bigint AS micros
    FROM billing_audit_events
    WHERE "userId"=${userId} AND "callId" IS NOT NULL AND source LIKE 'credit:%'`;
  return row!.micros;
}

/** Only capped reservations reach here. The user lock covers calls across billing organizations. */
export async function enforceModelCreditCap(
  tx: Prisma.TransactionClient,
  userId: string,
  reservationMicros: bigint,
) {
  await runAsSystemInTransaction(tx, "enforce an operator-set model credit cap", async () => {
    const [user] = await tx.$queryRaw<{ modelCreditCapMicros: bigint | null }[]>`
      SELECT "modelCreditCapMicros" FROM "user" WHERE id=${userId} FOR UPDATE`;
    if (user?.modelCreditCapMicros == null) return;
    if ((await committedModelCredits(tx, userId)) + reservationMicros > user.modelCreditCapMicros)
      throw new Error(MODEL_CREDIT_CAP_REACHED_ERROR);
  });
}

/** Operator-only control; no user-facing mutation exposes this setting. Null removes the cap. */
export async function setModelCreditCap(
  prisma: PrismaClient,
  userId: string,
  capMicros: bigint | null,
) {
  if (capMicros !== null && (capMicros < 0n || capMicros > 10_000_000_000n))
    throw new Error("Usage cap must be between $0 and $10,000");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id=${userId} FOR UPDATE`;
    const previous = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { modelCreditCapMicros: true },
    });
    await tx.user.update({ where: { id: userId }, data: { modelCreditCapMicros: capMicros } });
    await tx.billingAuditEvent.create({
      data: {
        source: `usage-cap:${randomUUID()}`,
        kind: "usage_cap_changed",
        userId,
        details: {
          previousMicros: previous.modelCreditCapMicros?.toString() ?? null,
          capMicros: capMicros?.toString() ?? null,
          by: "operator",
        },
      },
    });
    return modelCreditCapStatusTx(tx, userId);
  });
}

async function modelCreditCapStatusTx(tx: Prisma.TransactionClient, userId: string) {
  const { modelCreditCapMicros: capMicros } = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { modelCreditCapMicros: true },
  });
  const committedMicros = await committedModelCredits(tx, userId);
  const remaining = capMicros === null ? null : capMicros - committedMicros;
  return {
    capMicros,
    committedMicros,
    remainingMicros: remaining === null ? null : remaining > 0n ? remaining : 0n,
  };
}

export function modelCreditCapStatus(prisma: PrismaClient, userId: string) {
  return prisma.$transaction((tx) => modelCreditCapStatusTx(tx, userId));
}
