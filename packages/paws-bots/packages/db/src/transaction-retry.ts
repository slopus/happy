// Transactions that lock the thread row before writing run state share the body budget: the
// lock is held up to 15s by snapshot reads, Prisma's 5s default counts that wait, and expiring
// fails a user stop, clear, send, reaction or card answer, a run's steering claim or takeover
// handoff, or a run whose work already finished. Only the timeout is shared; an explicit
// maxWait would override the client's longer connection wait, so a saturated pool that frees
// a connection late would fail the checkout instead of waiting.
export const THREAD_LOCK_TRANSACTION_OPTIONS = { timeout: 20_000 };

const MAX_TRANSACTION_ATTEMPTS = 3;
const RETRYABLE_DATABASE_CODES = new Set(["40001", "40P01"]);

/**
 * Prisma's P2028 also covers a transaction that expired after running statements; only one
 * that never started (no connection within maxWait) is safe to run again.
 */
const UNSTARTED_TRANSACTION = /Unable to start a transaction in the given time/;

function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof Error && UNSTARTED_TRANSACTION.test(error.message)) return true;
  // A conflict at commit reaches the caller as the driver adapter's own error, unwrapped.
  const driverCode = (error as { cause?: { originalCode?: unknown } }).cause?.originalCode;
  if (typeof driverCode === "string" && RETRYABLE_DATABASE_CODES.has(driverCode)) return true;
  if (!("code" in error)) return false;
  const prismaError = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (prismaError.code === "P2034") return true;
  const databaseCode = prismaError.meta?.driverAdapterError?.cause?.originalCode;
  return typeof databaseCode === "string" && RETRYABLE_DATABASE_CODES.has(databaseCode);
}

export async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt >= MAX_TRANSACTION_ATTEMPTS) {
        throw error;
      }
    }
  }
}
