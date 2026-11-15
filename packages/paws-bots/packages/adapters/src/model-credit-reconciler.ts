import type { AgentUsage, ModelUsageLookup } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  expireModelCredits,
  hasFinalModelCost,
  MICROS_PER_DOLLAR,
  Prisma,
  RECONCILED_ESTIMATE_COST_SOURCE,
  recordUsage,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { PAID_SERVICE_USAGE_PROVIDER } from "./paid-service-tools.js";

/**
 * When the provider never reports a cost, a call that reached it is charged for the tokens we
 * counted: at the model's cheapest rates, or its full rates when the user stopped it. One that
 * never reached it is free. Never more than held.
 * Null when tokens were counted but the receipt has no price for them.
 */
function fallbackUsage(
  usage: AgentUsage | null,
  heldMicros: bigint,
  stoppedByUser: boolean,
): AgentUsage | null {
  const rates = usage?.pricingSnapshot;
  const rate = (key: string) => {
    const value = rates?.[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const counted =
    stoppedByUser && usage?.countedTokens?.ifStopped
      ? { ...usage.countedTokens.ifStopped, fullRate: true }
      : usage?.countedTokens && { ...usage.countedTokens, fullRate: false };
  // Provider-reported buckets first; our own count fills any the provider never sent.
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  const tokenCost =
    cacheRead * rate("cacheRead") +
    cacheWrite * rate("cacheWrite") +
    (usage?.inputTokens != null
      ? usage.inputTokens * rate("input")
      : // Our prompt count includes any reported cache buckets. Unless the user stopped the
        // call, assume the rest was served from cache too. A zero cache price means none.
        Math.max(0, (counted?.inputTokens ?? 0) - cacheRead - cacheWrite) *
        (counted?.fullRate ? rate("input") : rate("cacheRead") || rate("input"))) +
    // A stream's first frame can report a placeholder output count; what we received is a floor.
    Math.max(usage?.outputTokens ?? 0, counted?.outputTokens ?? 0) * rate("output");
  const knownCost =
    usage?.costUsd != null && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
      ? usage.costUsd
      : null;
  const counts = [
    usage?.inputTokens,
    usage?.outputTokens,
    usage?.cacheReadTokens,
    usage?.cacheWriteTokens,
    counted?.inputTokens,
    counted?.outputTokens,
  ];
  if (
    knownCost === null &&
    counts.some((count) => (count ?? 0) > 0) &&
    !["input", "output", "cacheRead", "cacheWrite"].some((key) => rate(key) > 0)
  )
    return null;
  const costUsd = Math.min(
    knownCost ?? tokenCost / 1_000_000,
    Math.max(0, Number(heldMicros)) / MICROS_PER_DOLLAR,
  );
  return {
    inputTokens: null,
    outputTokens: null,
    ...usage,
    costUsd,
    costSource: RECONCILED_ESTIMATE_COST_SOURCE,
  };
}

/** Bounded, leased recovery: provider cost first, then counted tokens, never more than held. */
export function createModelCreditReconciler(deps: {
  prisma: PrismaClient;
  lookup?: ModelUsageLookup;
  now?: () => Date;
}) {
  const { prisma, lookup } = deps;
  let balanceCursor: string | undefined;
  let nextBalanceAuditAt = 0;
  return () =>
    runAsSystem("reconcile model usage and credit balances", async () => {
      const now = deps.now?.() ?? new Date();
      const expiring = await prisma.modelCreditLot.findMany({
        where: { expiresAt: { lte: now }, availableMicros: { gt: 0n } },
        select: { organizationId: true },
        take: 25,
      });
      for (const organizationId of new Set(expiring.map((lot) => lot.organizationId)))
        await expireModelCredits(prisma, organizationId, now);
      const calls = await prisma.modelCreditEntry.findMany({
        where: {
          reconciliationState: "pending",
          nextReconcileAt: { lte: now },
          callId: { not: null },
        },
        orderBy: [{ nextReconcileAt: "asc" }, { id: "asc" }],
        take: 5,
      });
      await Promise.all(
        calls.map(async (call) => {
          const claimed = await prisma.modelCreditEntry.updateMany({
            where: {
              id: call.id,
              auditRevision: call.auditRevision,
              reconciliationState: "pending",
            },
            data: {
              nextReconcileAt: new Date(now.getTime() + 120_000),
              reconciliationAttempts: { increment: 1 },
            },
          });
          if (!claimed.count) return;
          let complete = false;
          // Why this attempt could not settle the hold, for whoever reviews it.
          let reason = "usage unavailable";
          const lastAttempt = call.reconciliationAttempts >= 5;
          // A call with no receipt whose run still holds its lease may still be streaming.
          let running = false;
          try {
            if (!call.callId || !call.userId || !call.spaceId || !call.provider || !call.model)
              throw new Error("Legacy reservation requires manual attribution");
            let usage = call.usage as unknown as AgentUsage | null;
            let reconciled = false;
            const canLookUp = lookup?.provider === call.provider && !!call.providerRequestId;
            if (canLookUp) {
              try {
                const recovered = await lookup.lookupUsage(call.providerRequestId!);
                if (recovered) {
                  usage = { ...usage, ...recovered };
                  reconciled = true;
                } else reason = "provider has no usage for the request";
              } catch (error) {
                // The last attempt falls back to counted tokens rather than holding the estimate.
                if (!lastAttempt) throw error;
                reason = error instanceof Error ? error.message : String(error);
              }
            }
            // Stop cancels the run; a deploy or a stalled stream aborts the call but not the run,
            // and a stuck-run cancel records why in `error`.
            let stoppedByUser = false;
            if (call.runId && ((!usage && lastAttempt) || usage?.countedTokens?.ifStopped)) {
              const run = await prisma.run.findUnique({
                where: { id: call.runId },
                select: { status: true, leaseExpiresAt: true, error: true },
              });
              // A deleted run cannot prove the call was not stopped by its user.
              // Keep the conservative full-rate count until provider evidence replaces it.
              stoppedByUser = !run || (run.status === "cancelled" && run.error == null);
              running =
                !usage &&
                (run?.status === "leased" || run?.status === "running") &&
                !!run.leaseExpiresAt &&
                run.leaseExpiresAt > now;
              if (running) reason = "call is still running";
            }
            // A paid service has no usage lookup and may have charged the deployment's account,
            // so an unfinished call goes to review instead of settling at no cost.
            const unfinishedPaidService = call.provider === PAID_SERVICE_USAGE_PROVIDER && !usage;
            if (unfinishedPaidService) reason = "paid service call did not finish";
            // Without a receipt the call may still be running, so only the last attempt settles it.
            if (
              !(usage && hasFinalModelCost(usage)) &&
              !running &&
              !unfinishedPaidService &&
              (lastAttempt || (usage && !canLookUp))
            ) {
              const fallback = fallbackUsage(usage, -call.amountMicros, stoppedByUser);
              if (fallback) {
                usage = fallback;
                reconciled = true;
                getLogger().info("Model credit hold settled without a provider cost", {
                  callId: call.callId,
                  reason,
                  costUsd: usage.costUsd,
                  hasProviderRequestId: Boolean(call.providerRequestId),
                  counted: Boolean(usage.countedTokens),
                  stoppedByUser,
                });
              } else reason = "no price for the counted tokens";
            }
            if (
              usage &&
              usage.costUsd != null &&
              (call.pending || reconciled || hasFinalModelCost(usage))
            ) {
              await recordUsage(
                prisma,
                {
                  ...usage,
                  type: "usage",
                  provider: call.provider,
                  model: call.model,
                  callId: call.callId,
                },
                {
                  userId: call.userId,
                  spaceId: call.spaceId,
                  runId: call.runId ?? undefined,
                  operationId: call.runId ?? call.callId,
                  operationKind: usage.operationKind ?? "answer",
                },
                true,
              );
              complete = hasFinalModelCost(usage);
              if (!complete) reason = "cost is not final";
            } else if (usage && reason === "usage unavailable") {
              reason = usage.costUsd == null ? "cost unavailable" : "cost is not final";
            }
          } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
            getLogger().warn("Model credit reconciliation could not verify a call", {
              callId: call.callId,
              reason,
            });
          }
          const needsReview = !complete && !running && lastAttempt;
          await prisma.modelCreditEntry.updateMany({
            where: { id: call.id, reconciliationState: "pending" },
            data: {
              reconciliationState: complete ? "complete" : needsReview ? "needs_review" : "pending",
              nextReconcileAt:
                complete || needsReview
                  ? null
                  : new Date(
                      now.getTime() +
                        Math.min(3_600_000, 30_000 * 2 ** call.reconciliationAttempts),
                    ),
            },
          });
          if (needsReview)
            getLogger().error("Model credit hold requires review", {
              callId: call.callId,
              reason,
              provider: call.provider,
              model: call.model,
              pending: call.pending,
              attempts: call.reconciliationAttempts + 1,
              hasProviderRequestId: Boolean(call.providerRequestId),
              canLookUpUsage: lookup?.provider === call.provider,
            });
        }),
      );
      // Hourly full journal verification, paginated separately from frequent call recovery.
      if (!balanceCursor && now.getTime() < nextBalanceAuditAt) return;
      const accounts = await prisma.modelCreditAccount.findMany({
        where: balanceCursor ? { organizationId: { gt: balanceCursor } } : {},
        orderBy: { organizationId: "asc" },
        take: 25,
        select: { organizationId: true },
      });
      balanceCursor = accounts.length === 25 ? accounts.at(-1)!.organizationId : undefined;
      if (!balanceCursor) nextBalanceAuditAt = now.getTime() + 3_600_000;
      // One read checks the page; only accounts that disagree are locked and rebuilt.
      const drifted = accounts.length
        ? await prisma.$queryRaw<Array<{ organizationId: string }>>`
            SELECT a."organizationId" FROM model_credit_accounts a
            WHERE a."organizationId" IN (${Prisma.join(accounts.map((account) => account.organizationId))})
              AND a."balanceMicros" <> COALESCE((
                SELECT SUM(e."amountMicros") FROM billing_audit_events e
                WHERE e."organizationId" = a."organizationId"
              ), 0)`
        : [];
      for (let offset = 0; offset < drifted.length; offset += 5)
        await Promise.all(
          drifted.slice(offset, offset + 5).map(({ organizationId }) =>
            prisma.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT "organizationId" FROM model_credit_accounts WHERE "organizationId"=${organizationId} FOR UPDATE`;
              const account = await tx.modelCreditAccount.findUnique({ where: { organizationId } });
              if (!account) return;
              const total = await tx.billingAuditEvent.aggregate({
                where: { organizationId },
                _sum: { amountMicros: true },
              });
              const expected = total._sum.amountMicros ?? 0n;
              if (expected === account.balanceMicros) return;
              await tx.billingAuditEvent.create({
                data: {
                  source: `balance:${organizationId}:${crypto.randomUUID()}`,
                  kind: "balance_rebuilt",
                  organizationId,
                  details: {
                    balanceMicros: account.balanceMicros.toString(),
                    expectedMicros: expected.toString(),
                  },
                },
              });
              await tx.modelCreditAccount.update({
                where: { organizationId },
                data: { balanceMicros: expected },
              });
              getLogger().error("Model credit balance does not match the audit journal", {
                organizationId,
              });
            }),
          ),
        );
    });
}
