import type { SpendingLimit, SpendingPayment, SpendingStatus } from "@rakazo/contracts";
import {
  MAX_SPENDING_LIMIT,
  SPENDING_CURRENCIES,
  SpendingLimitSchema,
  SpendingPeriodSchema,
} from "@rakazo/contracts";
import { spendingPeriodStart } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { runAsSystem } from "./row-security.js";

type SpendingClient = Pick<
  PrismaClient,
  "spendingLimit" | "payment" | "user" | "vaultCredential" | "paymentWallet" | "$transaction"
>;
type SpendingTx = Pick<
  Prisma.TransactionClient,
  "spendingLimit" | "payment" | "user" | "$queryRaw"
>;

export type StoredSpendingLimit = SpendingLimit & { startsAt: Date };

/** A payment about to go through. `amount` and `currency` are null when the page's total could not be read. */
export type PaymentInput = {
  operationKey: string;
  userId: string;
  spaceId: string;
  botId: string;
  threadId: string;
  /** The checkout's host. */
  site: string;
  amount: number | null;
  currency: string | null;
};

/**
 * Why a payment may not go through. `unchecked`: a limit is set and the amount could not be read,
 * or is in another currency, so it cannot be counted against it.
 */
export type PaymentRefusal = {
  refused: "over_limit" | "unchecked";
  limit: SpendingLimit;
  spent: number;
};

export async function loadSpendingLimit(
  prisma: Pick<PrismaClient, "spendingLimit"> | Pick<Prisma.TransactionClient, "spendingLimit">,
  userId: string,
): Promise<StoredSpendingLimit | null> {
  const row = await prisma.spendingLimit.findUnique({ where: { userId } });
  if (!row) return null;
  const limit = SpendingLimitSchema.safeParse({
    amount: row.amount,
    currency: row.currency,
    period: row.period,
  });
  if (limit.success) return { ...limit.data, startsAt: row.startsAt };
  // A stored limit this release can't read still limits: each part it can't read becomes the
  // strictest valid one, and it stays in Settings for the user to fix.
  getLogger().warn("stored spending limit is invalid; enforcing the strictest reading");
  return {
    amount: Math.min(Math.max(Math.trunc(row.amount) || 1, 1), MAX_SPENDING_LIMIT),
    currency: SPENDING_CURRENCIES.find((currency) => currency === row.currency) ?? "usd",
    period: SpendingPeriodSchema.safeParse(row.period).data ?? "none",
    startsAt: row.startsAt,
  };
}

async function spentIn(
  prisma: Pick<SpendingTx, "payment" | "user">,
  userId: string,
  limit: StoredSpendingLimit,
  now: Date,
): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const since = spendingPeriodStart(limit.period, limit.startsAt, user?.timezone, now);
  const { _sum } = await prisma.payment.aggregate({
    _sum: { amount: true },
    where: { userId, currency: limit.currency, releasedAt: null, createdAt: { gte: since } },
  });
  return _sum.amount ?? 0;
}

function judge(
  limit: StoredSpendingLimit | null,
  spent: number,
  input: Pick<PaymentInput, "amount" | "currency">,
): PaymentRefusal | null {
  if (!limit) return null;
  const { amount, period, currency } = limit;
  const shown = { amount, period, currency };
  if (input.amount === null || input.currency !== limit.currency)
    return { refused: "unchecked", limit: shown, spent };
  return spent + input.amount > limit.amount
    ? { refused: "over_limit", limit: shown, spent }
    : null;
}

/** Whether a payment would be refused now. Nothing is recorded: `recordPayment` decides for good. */
export async function checkPayment(
  prisma: Pick<SpendingClient, "spendingLimit" | "payment" | "user">,
  input: Pick<PaymentInput, "userId" | "amount" | "currency">,
  now = new Date(),
): Promise<PaymentRefusal | null> {
  const limit = await loadSpendingLimit(prisma, input.userId);
  return judge(limit, limit ? await spentIn(prisma, input.userId, limit, now) : 0, input);
}

/**
 * Count a payment that is about to go through, or refuse it. One user's payments are counted one at
 * a time, so two that each fit under the limit cannot both pass when together they don't. The same
 * operation is counted once. Without a limit, a payment whose amount could not be read is not recorded.
 */
export async function recordPayment(
  prisma: Pick<SpendingClient, "$transaction">,
  input: PaymentInput,
  at?: Date,
): Promise<PaymentRefusal | null> {
  return prisma.$transaction(async (tx) => {
    await lockSpending(tx, input.userId);
    // Read once the lock is held: a payment that waited past a reset belongs to the new period.
    const now = at ?? new Date();
    const existing = await tx.payment.findUnique({
      where: { operationKey: input.operationKey },
      select: { releasedAt: true },
    });
    if (existing && !existing.releasedAt) return null;
    const limit = await loadSpendingLimit(tx, input.userId);
    const refusal = judge(limit, limit ? await spentIn(tx, input.userId, limit, now) : 0, input);
    if (refusal || input.amount === null || input.currency === null) return refusal;
    const data = {
      userId: input.userId,
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      site: input.site.slice(0, 253),
      amount: input.amount,
      currency: input.currency,
    };
    await tx.payment.upsert({
      where: { operationKey: input.operationKey },
      create: { operationKey: input.operationKey, ...data, createdAt: now },
      update: { ...data, releasedAt: null, createdAt: now },
    });
    return null;
  });
}

/** Stop counting a payment that did not go through. */
export async function releasePayment(
  prisma: Pick<PrismaClient, "payment">,
  operationKey: string,
): Promise<void> {
  await prisma.payment.updateMany({
    where: { operationKey, releasedAt: null },
    data: { releasedAt: new Date() },
  });
}

/**
 * Stop counting the Space's wallet purchases still waiting on the wallet owner: the Space is about to
 * be deleted, its purchases with it, so no bot can pay with them and the poller can no longer settle
 * them. Approved ones keep counting, since their card may have been used. Runs in the deletion's
 * transaction.
 */
export async function releasePendingSpacePayments(
  tx: Pick<Prisma.TransactionClient, "purchase" | "payment">,
  spaceId: string,
): Promise<void> {
  const pending = await tx.purchase.findMany({
    where: { spaceId, status: { in: ["pending_approval", "needs_action"] } },
    select: { operationKey: true },
  });
  if (!pending.length) return;
  await tx.payment.updateMany({
    where: { operationKey: { in: pending.map((row) => row.operationKey) }, releasedAt: null },
    data: { releasedAt: new Date() },
  });
}

/** The limit and what counts against it now, for Settings. */
export async function spendingStatus(
  prisma: Pick<
    SpendingClient,
    "spendingLimit" | "payment" | "user" | "vaultCredential" | "paymentWallet"
  >,
  userId: string,
  now = new Date(),
): Promise<SpendingStatus> {
  const stored = await loadSpendingLimit(prisma, userId);
  const limit = stored
    ? { amount: stored.amount, currency: stored.currency, period: stored.period }
    : null;
  return {
    limit,
    spent: stored ? await spentIn(prisma, userId, stored, now) : 0,
    shown: Boolean(stored) || (await canPay(prisma, userId)),
  };
}

// The limit matters once a bot has a way to pay, a saved card or a connected wallet, or has paid.
async function canPay(
  prisma: Pick<SpendingClient, "vaultCredential" | "paymentWallet" | "payment">,
  userId: string,
): Promise<boolean> {
  const [card, wallet, paid] = await Promise.all([
    prisma.vaultCredential.findFirst({
      where: { userId, auth: { path: ["type"], equals: "card" } },
      select: { id: true },
    }),
    prisma.paymentWallet.findFirst({
      where: { userId, status: "connected" },
      select: { id: true },
    }),
    prisma.payment.findFirst({ where: { userId, releasedAt: null }, select: { id: true } }),
  ]);
  return Boolean(card || wallet || paid);
}

/**
 * The latest payments that count, newest first, each with its bot's name while the bot is in a Space the
 * user belongs to. Payments are the user's across Spaces, so names are read across the user's Spaces too.
 */
export async function recentPayments(
  prisma: Pick<PrismaClient, "payment" | "bot">,
  userId: string,
  take = 50,
): Promise<SpendingPayment[]> {
  const rows = await prisma.payment.findMany({
    where: { userId, releasedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: { id: true, site: true, amount: true, currency: true, botId: true, createdAt: true },
  });
  const bots = await runAsSystem("payment bot names in the user's Spaces", () =>
    prisma.bot.findMany({
      where: {
        id: { in: [...new Set(rows.map((row) => row.botId))] },
        space: { memberships: { some: { userId } } },
      },
      select: { id: true, name: true },
    }),
  );
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  return rows.map(({ botId, createdAt, ...row }) => ({
    ...row,
    botName: names.get(botId) ?? null,
    createdAt: createdAt.toISOString(),
  }));
}

/**
 * Set or remove the limit. Changing the amount keeps what was spent; a limit that never resets
 * starts counting again when it is set, or switched to from one that resets.
 */
export async function saveSpendingLimit(
  prisma: Pick<PrismaClient, "$transaction">,
  userId: string,
  limit: SpendingLimit | null,
): Promise<void> {
  // Under the payments' lock, so a payment checked against the old limit is recorded before the new
  // one is saved, and every later payment sees the new one.
  await prisma.$transaction(async (tx) => {
    await lockSpending(tx, userId);
    if (!limit) {
      await tx.spendingLimit.deleteMany({ where: { userId } });
      return;
    }
    const current = await tx.spendingLimit.findUnique({
      where: { userId },
      select: { period: true },
    });
    const restart = limit.period === "none" && current?.period !== "none";
    await tx.spendingLimit.upsert({
      where: { userId },
      create: { userId, ...limit },
      update: { ...limit, ...(restart ? { startsAt: new Date() } : {}) },
    });
  });
}

/** One user's payments and limit changes are decided one at a time. */
async function lockSpending(tx: Pick<Prisma.TransactionClient, "$queryRaw">, userId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`spending:${userId}`}, 0))::text AS "lock"
  `);
}
