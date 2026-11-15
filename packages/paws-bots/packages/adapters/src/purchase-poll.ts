import type { AdapterContext, PurchaseSnapshot, PurchaseStatus } from "@rakazo/adapter-kit";
import {
  PaymentWalletDisconnected,
  PaymentWalletRequestRejected,
  runContinueJob,
} from "@rakazo/adapter-kit";
import type { Purchase } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { PurchaseDeps } from "./purchase-service.js";
import {
  enqueuePurchasePoll,
  fetchPurchase,
  PENDING_PURCHASE_STATUSES,
  PURCHASE_POLL_MS,
} from "./purchase-service.js";
import { releaseUnpaidPurchase } from "./spending-gate.js";

/** Providers expire approval requests after 30 minutes; stop asking a little later. */
export const PURCHASE_POLL_DEADLINE_MS = 35 * 60_000;
const RETRY_MS = 30_000;

/** Changes the bot has to act on. A completed purchase was the bot's own doing. */
const WAKE_STATUSES: ReadonlySet<string> = new Set<PurchaseStatus>([
  "approved",
  "denied",
  "expired",
  "needs_action",
  "canceled",
  "failed",
]);

/** Check one purchase the wallet owner has not decided yet, and wake its bot on a change. */
export async function pollPurchase(deps: PurchaseDeps, payload: { purchaseId: string }) {
  const provider = deps.paymentWallet;
  if (!provider) return;
  const purchase = await deps.prisma.purchase.findFirst({
    where: { id: payload.purchaseId, provider: provider.describe().id },
  });
  if (!purchase?.nextPollAt) return;
  if (!PENDING_PURCHASE_STATUSES.has(purchase.status)) {
    await settle(deps, purchase, { status: purchase.status as PurchaseStatus });
    return;
  }
  if (Date.now() - purchase.createdAt.getTime() >= PURCHASE_POLL_DEADLINE_MS) {
    await settle(deps, purchase, { status: "expired" });
    return;
  }
  const context: AdapterContext = {
    operationId: `purchase.poll:${purchase.id}`,
    traceId: purchase.id,
    spaceId: purchase.spaceId,
    userId: purchase.userId,
    botId: purchase.botId,
    signal: AbortSignal.timeout(30_000),
  };
  let snapshot: PurchaseSnapshot;
  try {
    snapshot = await fetchPurchase(deps, provider, purchase, context);
  } catch (error) {
    if (error instanceof PaymentWalletRequestRejected) {
      // The provider no longer knows this purchase; asking again cannot succeed.
      await settle(deps, purchase, { status: "failed" });
      return;
    }
    // A disconnected wallet may be reconnected before the deadline; keep trying until then.
    if (error instanceof PaymentWalletDisconnected)
      getLogger().warn("purchase poll waiting on a wallet connection");
    else getLogger().warn("purchase poll deferred");
    const nextPollAt = new Date(Date.now() + RETRY_MS);
    const saved = await deps.prisma.purchase.updateMany({
      where: { id: purchase.id, updatedAt: purchase.updatedAt },
      data: { nextPollAt },
    });
    if (saved.count) await enqueuePurchasePoll(deps, purchase.id, nextPollAt);
    return;
  }
  await settle(deps, purchase, {
    status: snapshot.status,
    approvalUrl: snapshot.approvalUrl ?? purchase.approvalUrl,
  });
}

async function settle(
  deps: PurchaseDeps,
  purchase: Purchase,
  next: { status: PurchaseStatus; approvalUrl?: string | null },
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat: thread first, then the run it queues.
    // Clearing the chat bumps its generation, so a cleared chat is not woken for an old purchase.
    const thread = await tx.thread.updateMany({
      where: {
        id: purchase.threadId,
        spaceId: purchase.spaceId,
        userId: purchase.userId,
        historyCompactionGeneration: purchase.threadGeneration,
      },
      data: { nextEventSeq: { increment: 0 } },
    });
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: purchase.spaceId, userId: purchase.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: {
          id: purchase.botId,
          spaceId: purchase.spaceId,
          userId: purchase.userId,
          archivedAt: null,
        },
        select: { id: true },
      }),
    ]);
    const attached = thread.count > 0 && Boolean(member) && Boolean(bot);
    const pending = PENDING_PURCHASE_STATUSES.has(next.status);
    // Nobody is left to tell once the bot, its chat or its owner is gone, or the chat was cleared, so
    // nothing is woken; the purchase is still polled until it settles or expires, so a purchase that
    // never went through stops counting against the spending limit.
    const nextPollAt = pending ? new Date(Date.now() + PURCHASE_POLL_MS) : null;
    const wake = attached && WAKE_STATUSES.has(next.status) && next.status !== purchase.wokenStatus;
    // The updatedAt fence makes a concurrent poll or purchase_status write win once.
    const updated = await tx.purchase.updateMany({
      where: { id: purchase.id, updatedAt: purchase.updatedAt },
      data: {
        status: next.status,
        ...(next.approvalUrl !== undefined ? { approvalUrl: next.approvalUrl } : {}),
        nextPollAt,
        ...(wake ? { wokenStatus: next.status } : {}),
      },
    });
    if (!updated.count) return null;
    await releaseUnpaidPurchase(tx, purchase.operationKey, next.status);
    if (!wake) return { nextPollAt };
    const clientNonce = `purchase-wake:${purchase.id}:${next.status}`;
    // A status that comes back (approved, needs_action, approved) already woke the bot once.
    const prior = await tx.run.findFirst({
      where: { spaceId: purchase.spaceId, clientNonce },
      select: { id: true },
    });
    if (prior) return { nextPollAt };
    // Provider text is untrusted. Wake with local identity and status only.
    const task = await tx.task.create({
      data: {
        spaceId: purchase.spaceId,
        botId: purchase.botId,
        threadId: purchase.threadId,
        userId: purchase.userId,
        prompt: `Purchase ${purchase.id} is ${next.status}. Use purchase_status to continue.`,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: purchase.spaceId,
        botId: purchase.botId,
        threadId: purchase.threadId,
        userId: purchase.userId,
        taskId: task.id,
        status: "queued",
        trigger: "purchase",
        clientNonce,
      },
    });
    return { nextPollAt, wakeRunId: run.id };
  });
  if (!committed) return;
  if (committed.wakeRunId) {
    // The run reconciler recovers a queued wake after an enqueue failure.
    await deps.jobs.enqueue(runContinueJob(committed.wakeRunId)).catch(() => {
      getLogger().warn("purchase wake deferred to reconciliation");
    });
  }
  if (committed.nextPollAt) await enqueuePurchasePoll(deps, purchase.id, committed.nextPollAt);
}

/** Re-enqueue purchases whose poll is due, after a lost job or a worker restart. */
export async function reconcilePurchases(
  deps: Pick<PurchaseDeps, "prisma" | "jobs" | "paymentWallet">,
) {
  if (!deps.paymentWallet) return;
  const due = await deps.prisma.purchase.findMany({
    where: { provider: deps.paymentWallet.describe().id, nextPollAt: { lte: new Date() } },
    orderBy: [{ nextPollAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true },
  });
  for (const purchase of due) await enqueuePurchasePoll(deps, purchase.id);
}
