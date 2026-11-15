import { randomUUID } from "node:crypto";
import type { Prisma } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
export type CreditAllocation = { lotId: string; amountMicros: string };
export const allocatedMicros = (allocations: CreditAllocation[]) =>
  allocations.reduce((sum, item) => sum + BigInt(item.amountMicros), 0n);
const positive = (amount: bigint) => (amount > 0n ? amount : 0n);

/** Keep old-release writes and pre-lot balances usable during a rolling deployment. */
export async function prepareCreditLots(tx: Tx, organizationId: string, now = new Date()) {
  const purchases = await tx.$queryRaw<
    Array<{ id: string; lotId: string | null; amountMicros: bigint; createdAt: Date }>
  >`
    SELECT e.id,l.id AS "lotId",e."amountMicros",e."createdAt"
    FROM model_credit_entries e LEFT JOIN model_credit_lots l ON l.id=e.id
    WHERE e."organizationId"=${organizationId} AND e.source LIKE 'purchase:%'
      AND ((l.id IS NULL AND e."amountMicros">0) OR l."amountMicros"<>e."amountMicros")
    ORDER BY e."createdAt",e.id`;
  for (const purchase of purchases) {
    if (purchase.lotId) await resizeCreditLot(tx, purchase.id, purchase.amountMicros);
    else
      await tx.modelCreditLot.create({
        data: {
          id: purchase.id,
          organizationId,
          amountMicros: purchase.amountMicros,
          availableMicros: purchase.amountMicros,
          createdAt: purchase.createdAt,
        },
      });
  }
  // Previous-release calls have already debited the wallet. Attach their funding before
  // reconciling the aggregate balance so a late release retains its original expiry.
  for (;;) {
    const calls = await tx.$queryRaw<Array<{ id: string; amountMicros: bigint; createdAt: Date }>>`
      SELECT id,"amountMicros","createdAt" FROM model_credit_entries
      WHERE "organizationId"=${organizationId} AND source LIKE 'call:%'
        AND allocations IS NULL AND "amountMicros"<0
      ORDER BY "createdAt",id LIMIT 100`;
    if (!calls.length) break;
    for (const call of calls) {
      const allocations = await allocateCreditLots(
        tx,
        organizationId,
        -call.amountMicros,
        call.createdAt,
        call.createdAt,
      );
      await tx.modelCreditEntry.update({
        where: { id: call.id },
        data: { allocations, fundedMicros: allocatedMicros(allocations) },
      });
    }
  }
  // The previous API can also settle a hold after the new API classified it.
  // Return excess allocations without crediting the wallet a second time.
  const released = await tx.$queryRaw<
    Array<{
      id: string;
      amountMicros: bigint;
      allocations: CreditAllocation[];
      fundedMicros: bigint;
    }>
  >`
    SELECT id,"amountMicros",allocations,"fundedMicros" FROM model_credit_entries
    WHERE "organizationId"=${organizationId} AND source LIKE 'call:%'
      AND "fundedMicros">GREATEST(-"amountMicros",0)`;
  for (const call of released) {
    const spent = positive(-call.amountMicros);
    const allocations = await returnCreditLots(
      tx,
      call.allocations,
      call.fundedMicros - spent,
      now,
    );
    await tx.modelCreditEntry.update({
      where: { id: call.id },
      data: { allocations, fundedMicros: allocatedMicros(allocations) },
    });
  }
  await syncLotBalance(tx, organizationId);
}

export async function syncLotBalance(tx: Tx, organizationId: string) {
  const account = await tx.modelCreditAccount.findUniqueOrThrow({ where: { organizationId } });
  const total = await tx.modelCreditLot.aggregate({
    where: { organizationId, availableMicros: { gt: 0n } },
    _sum: { availableMicros: true },
  });
  const difference = positive(account.balanceMicros) - (total._sum.availableMicros ?? 0n);
  if (difference > 0n)
    await tx.modelCreditLot.create({
      data: {
        id: `legacy:${randomUUID()}`,
        organizationId,
        amountMicros: difference,
        availableMicros: difference,
      },
    });
  else if (difference < 0n) await allocateCreditLots(tx, organizationId, -difference, undefined);
}

/** Refunds remove expired value before charging any funds already spent. */
export async function resizeCreditLot(tx: Tx, id: string, amountMicros: bigint, expiresAt?: Date) {
  const lot = await tx.modelCreditLot.findUniqueOrThrow({ where: { id } });
  if (amountMicros > lot.amountMicros) throw new Error("A refunded credit grant cannot grow");
  if (lot.expiresAt && expiresAt && lot.expiresAt.getTime() !== expiresAt.getTime())
    throw new Error("Credit service period changed");
  if (
    amountMicros === lot.amountMicros &&
    (!expiresAt || lot.expiresAt?.getTime() === expiresAt.getTime())
  )
    return;
  const expiredMicros = positive(lot.expiredMicros + amountMicros - lot.amountMicros);
  const availableMicros = positive(amountMicros - lot.usedMicros - expiredMicros);
  await tx.modelCreditLot.update({
    where: { id },
    data: { amountMicros, availableMicros, expiredMicros, ...(expiresAt ? { expiresAt } : {}) },
  });
  await setExpiredCredits(tx, id, expiredMicros);
}

/** Account row must already be locked. Expiration has its own durable financial delta. */
export async function setExpiredCredits(tx: Tx, lotId: string, expiredMicros: bigint) {
  const lot = await tx.modelCreditLot.findUniqueOrThrow({ where: { id: lotId } });
  const source = `expiry:${lotId}`;
  const existing = await tx.modelCreditEntry.findUnique({ where: { source } });
  const amountMicros = -expiredMicros;
  const delta = amountMicros - (existing?.amountMicros ?? 0n);
  if (delta === 0n) return;
  await tx.modelCreditEntry.upsert({
    where: { source },
    create: { source, organizationId: lot.organizationId, amountMicros },
    update: { amountMicros },
  });
  await tx.modelCreditAccount.update({
    where: { organizationId: lot.organizationId },
    data: { balanceMicros: { increment: delta } },
  });
}

export async function expireCreditLots(tx: Tx, organizationId: string, now: Date) {
  const lots = await tx.modelCreditLot.findMany({
    where: { organizationId, expiresAt: { lte: now }, availableMicros: { gt: 0n } },
  });
  for (const lot of lots) {
    const expiredMicros = lot.expiredMicros + lot.availableMicros;
    await tx.modelCreditLot.update({
      where: { id: lot.id },
      data: { availableMicros: 0n, expiredMicros },
    });
    await setExpiredCredits(tx, lot.id, expiredMicros);
  }
}

/** Spend expiring credits first, preserving purchased top-ups. Undefined time also covers legacy debits. */
export async function allocateCreditLots(
  tx: Tx,
  organizationId: string,
  amount: bigint,
  now: Date | undefined,
  createdBefore?: Date,
): Promise<CreditAllocation[]> {
  const allocations: CreditAllocation[] = [];
  while (amount > 0n) {
    const lots = await tx.modelCreditLot.findMany({
      where: {
        organizationId,
        availableMicros: { gt: 0n },
        ...(createdBefore ? { createdAt: { lte: createdBefore } } : {}),
        ...(now ? { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } : {}),
      },
      orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      take: 32,
    });
    if (!lots.length) break;
    // Fully consumed lots leave the query, so each batch advances under the wallet lock.
    for (const lot of lots) {
      if (amount === 0n) break;
      const used = amount < lot.availableMicros ? amount : lot.availableMicros;
      await tx.modelCreditLot.update({
        where: { id: lot.id },
        data: { availableMicros: { decrement: used }, usedMicros: { increment: used } },
      });
      allocations.push({ lotId: lot.id, amountMicros: used.toString() });
      amount -= used;
    }
  }
  return allocations;
}

/** Reverse the latest allocations first. An expired or refunded grant cannot mint new spendable funds. */
export async function returnCreditLots(
  tx: Tx,
  allocations: CreditAllocation[],
  amount: bigint,
  now: Date,
) {
  for (let i = allocations.length - 1; i >= 0 && amount > 0n; i--) {
    const allocation = allocations[i]!;
    const held = BigInt(allocation.amountMicros);
    const returned = amount < held ? amount : held;
    const lot = await tx.modelCreditLot.findUniqueOrThrow({ where: { id: allocation.lotId } });
    const usedMicros = lot.usedMicros - returned;
    let expiredMicros = lot.expiredMicros;
    let availableMicros = positive(lot.amountMicros - usedMicros - expiredMicros);
    if (lot.expiresAt && lot.expiresAt <= now) {
      expiredMicros += availableMicros;
      availableMicros = 0n;
    }
    await tx.modelCreditLot.update({
      where: { id: lot.id },
      data: { usedMicros, availableMicros, expiredMicros },
    });
    if (expiredMicros !== lot.expiredMicros) await setExpiredCredits(tx, lot.id, expiredMicros);
    allocation.amountMicros = (held - returned).toString();
    amount -= returned;
  }
  return allocations.filter((allocation) => BigInt(allocation.amountMicros) > 0n);
}
