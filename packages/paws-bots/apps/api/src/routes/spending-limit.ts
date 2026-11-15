import { recentPayments, saveSpendingLimit, spendingStatus } from "@rakazo/db";
import type { RouterContext } from "./context.js";

/** The account's spending limit. Only the user sets it; bots have no tool for it. */
export function spendingLimitRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    spendingLimit: {
      get: authed.spendingLimit.get.handler(({ context }) =>
        spendingStatus(deps.prisma, context.actor.userId),
      ),
      set: authed.spendingLimit.set.handler(async ({ context, input }) => {
        await saveSpendingLimit(deps.prisma, context.actor.userId, input.limit);
        return spendingStatus(deps.prisma, context.actor.userId);
      }),
      payments: authed.spendingLimit.payments.handler(({ context }) =>
        recentPayments(deps.prisma, context.actor.userId),
      ),
    },
  };
}
