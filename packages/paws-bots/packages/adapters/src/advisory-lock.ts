import type { Prisma } from "@rakazo/db";

/**
 * How a lock's namespace and key become a Postgres advisory-lock key: `pair` locks
 * `hashtext(namespace), hashtext(key)`, `joined` locks `hashtextextended('namespace:key', 0)`.
 * The two are different lock keys, so each lock keeps the form it shipped with; switching
 * one would stop it excluding a release still running the old form.
 */
export type AdvisoryLockForm = "pair" | "joined";

/** Takes a transaction-scoped advisory lock on `key` within `namespace`, held until the transaction ends. */
export function advisoryLock(
  tx: Prisma.TransactionClient,
  namespace: string,
  key: string,
  form: AdvisoryLockForm = "pair",
): Promise<unknown> {
  return form === "pair"
    ? tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${namespace}), hashtext(${key}))`
    : tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))::text`;
}
