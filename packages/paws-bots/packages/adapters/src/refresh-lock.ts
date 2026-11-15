import type { Prisma, PrismaClient } from "@rakazo/db";

const REFRESH_LOCK_WAIT_MS = 10_000;
const REFRESH_TRANSACTION_MS = 60_000;
/**
 * Bounds the provider request a refresh makes while holding the refresh lock; the
 * rest of the transaction goes to the write, since a rotated token never committed is lost.
 */
export const REFRESH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Runs `fn` in a transaction that first takes `lock`, a transaction-scoped advisory
 * lock, so processes sharing the database refresh one rotating credential in turn.
 * The lock wait runs inside the transaction, so it gets its own cap.
 */
export function withRefreshLock<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${REFRESH_LOCK_WAIT_MS}ms`}, true)`;
      await lock(tx);
      return fn(tx);
    },
    { maxWait: REFRESH_LOCK_WAIT_MS, timeout: REFRESH_TRANSACTION_MS },
  );
}
