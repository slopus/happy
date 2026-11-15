import type { PrismaClient } from "@rakazo/db";

type UpdateManyArgs = Parameters<PrismaClient["billingAccount"]["updateMany"]>[0];

/**
 * `prisma`, plus a promise that settles once a checkout lease claim finds the lease held by
 * another attempt: that attempt is then queued behind the holder, so a test can release the
 * holder without guessing how long the queued attempt takes to get there.
 */
export function watchCheckoutLeaseClaims(prisma: PrismaClient) {
  let refused!: () => void;
  const leaseRefused = new Promise<void>((resolve) => {
    refused = resolve;
  });
  const watched = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== "billingAccount") return Reflect.get(target, property, receiver);
      return new Proxy(target.billingAccount, {
        get(accounts, method, accountsReceiver) {
          if (method !== "updateMany") return Reflect.get(accounts, method, accountsReceiver);
          return async (args: UpdateManyArgs) => {
            const result = await accounts.updateMany(args);
            // Only a claim writes a new lease id; a release clears it and a renewal keeps it.
            if (typeof args.data.checkoutLeaseId === "string" && result.count === 0) refused();
            return result;
          };
        },
      });
    },
  });
  return { prisma: watched, leaseRefused };
}
