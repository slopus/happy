import type { PurchaseStatus } from "@rakazo/adapter-kit";
import { formatMinorAmount, parsePageAmount } from "@rakazo/core";
import type { PaymentInput, PaymentRefusal, PrismaClient } from "@rakazo/db";
import { checkPayment, recordPayment, releasePayment } from "@rakazo/db";
import type { PurchaseApproval } from "./purchase-gate.js";

const PERIOD_TEXT = { day: "a day", week: "a week", month: "a month", none: "in total" } as const;

/** What the bot is told when a payment is refused by the user's spending limit. */
export function spendingRefusalError(refusal: PaymentRefusal): string {
  const { limit, spent } = refusal;
  const money = (amount: number) => formatMinorAmount(amount, limit.currency);
  if (refusal.refused === "unchecked")
    return `The total couldn't be read in ${limit.currency.toUpperCase()}, the currency of the user's spending limit, so it can't be counted against it and nothing was paid. Don't retry; tell the user.`;
  return `This would go over the user's spending limit of ${money(limit.amount)} ${PERIOD_TEXT[limit.period]} (${money(spent)} spent), so nothing was paid. Don't retry; tell the user.`;
}

type Run = { userId: string; spaceId: string; botId: string; threadId: string };

/**
 * A pay click as a payment: the page's host and the larger of the amount the card showed and the
 * page's total, since a button can name less than the checkout charges. Null when unreadable.
 */
function pagePayment(run: Run, purchase: PurchaseApproval, operationKey: string): PaymentInput {
  const amounts = purchase.site
    ? [purchase.amount, purchase.total ?? ""].filter(Boolean).map(parsePageAmount)
    : [];
  const read = amounts.length && amounts.every(Boolean) ? amounts.map((amount) => amount!) : [];
  const currency = read[0]?.currency;
  const counted =
    read.length && read.every((amount) => amount.currency === currency)
      ? Math.max(...read.map((amount) => amount.amount))
      : null;
  return {
    operationKey,
    ...run,
    site: purchase.site,
    amount: counted,
    currency: counted === null ? null : (currency ?? null),
  };
}

/**
 * The call pays only with a card or pay token the wallet issued for this purchase, which was counted
 * when it was requested, so its click is not counted again. A call that also types a saved card may
 * be paying with that card, so it counts.
 */
export function paysWithWallet(args: Record<string, unknown>): boolean {
  const steps = (Array.isArray(args.actions) ? (args.actions as unknown[]) : []).map(
    (raw) => (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>,
  );
  const named = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const wallet = steps.some(
    (step) => step.kind === "fill_pay_token" || (step.kind === "fill_card" && named(step.purchase)),
  );
  const saved = steps.some((step) => step.kind === "fill_card" && named(step.card));
  return wallet && !saved;
}

/** Refused before the card is shown, so the user isn't asked for a payment that can't go through. */
export async function pagePaymentPrecheck(
  prisma: Pick<PrismaClient, "spendingLimit" | "payment" | "user">,
  run: Run,
  purchase: PurchaseApproval,
): Promise<string | undefined> {
  const refusal = await checkPayment(prisma, pagePayment(run, purchase, ""));
  return refusal ? spendingRefusalError(refusal) : undefined;
}

/** Counted just before the approved click is pressed; refused if it no longer fits. */
export async function recordPagePayment(
  prisma: Pick<PrismaClient, "$transaction">,
  run: Run,
  purchase: PurchaseApproval,
  operationKey: string,
): Promise<string | undefined> {
  const refusal = await recordPayment(prisma, pagePayment(run, purchase, operationKey));
  return refusal ? spendingRefusalError(refusal) : undefined;
}

/** Wallet statuses where no money moved. */
const UNPAID: ReadonlySet<string> = new Set<PurchaseStatus>([
  "denied",
  "expired",
  "canceled",
  "failed",
]);

/** Stop counting a wallet purchase once it can no longer be paid. */
export async function releaseUnpaidPurchase(
  prisma: Pick<PrismaClient, "payment">,
  operationKey: string,
  status: string,
): Promise<void> {
  if (UNPAID.has(status)) await releasePayment(prisma, operationKey);
}
