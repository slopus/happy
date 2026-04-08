import { logger } from './logger';

export async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export function exponentialBackoffDelay(
  currentFailureCount: number,
  minDelay: number,
  maxDelay: number,
  maxFailureCount: number,
): number {
  const maxDelayForAttempt = minDelay
    + ((maxDelay - minDelay) / maxFailureCount) * Math.min(currentFailureCount, maxFailureCount);
  return Math.round(Math.random() * maxDelayForAttempt);
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export function createBackoff(opts?: {
  onError?: (error: unknown, failuresCount: number) => void;
  minDelay?: number;
  maxDelay?: number;
  maxFailureCount?: number;
}): BackoffFunc {
  return async function withBackoff<T>(callback: () => Promise<T>): Promise<T> {
    let currentFailureCount = 0;
    const minDelay = opts?.minDelay ?? 250;
    const maxDelay = opts?.maxDelay ?? 1000;
    const maxFailureCount = opts?.maxFailureCount ?? 50;

    while (true) {
      try {
        return await callback();
      } catch (error) {
        if (currentFailureCount < maxFailureCount) {
          currentFailureCount += 1;
        }
        opts?.onError?.(error, currentFailureCount);
        const waitForRequest = exponentialBackoffDelay(
          currentFailureCount,
          minDelay,
          maxDelay,
          maxFailureCount,
        );
        await delay(waitForRequest);
      }
    }
  };
}

export const backoff = createBackoff({
  onError: (error, failuresCount) => {
    logger.debug(`[BACKOFF] retry ${failuresCount}:`, error instanceof Error ? error.message : error);
  },
});
