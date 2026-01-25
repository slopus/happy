export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function linearBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    // Linearly ramp the delay as failures increase, capped at maxDelay, then apply jitter.
    const safeMaxFailureCount = Number.isFinite(maxFailureCount) ? Math.max(maxFailureCount, 1) : 50;
    const clampedFailureCount = Math.min(Math.max(currentFailureCount, 0), safeMaxFailureCount);
    const maxDelayRet = minDelay + ((maxDelay - minDelay) / safeMaxFailureCount) * clampedFailureCount;
    const jittered = Math.random() * maxDelayRet;
    return Math.max(minDelay, Math.round(jittered));
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export function createBackoff(
    opts?: {
        onError?: (e: any, failuresCount: number) => void,
        onRetry?: (e: any, failuresCount: number, nextDelayMs: number) => void,
        shouldRetry?: (e: any, failuresCount: number) => boolean,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        // Maximum number of failures we tolerate before giving up.
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 8;
        const shouldRetry = opts && opts.shouldRetry
            ? opts.shouldRetry
            : (e: any) => {
                // Default: do not retry explicitly non-retryable errors.
                // Duck-typed to avoid coupling this util to higher-level error classes.
                if (e && typeof e === 'object') {
                    if ((e as any).retryable === false) {
                        return false;
                    }
                    if (typeof (e as any).canTryAgain === 'boolean' && (e as any).canTryAgain === false) {
                        return false;
                    }
                }
                return true;
            };
        while (true) {
            try {
                return await callback();
            } catch (e) {
                currentFailureCount++;
                if (!shouldRetry(e, currentFailureCount)) {
                    throw e;
                }
                if (currentFailureCount >= maxFailureCount) {
                    throw e;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                let waitForRequest = linearBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                if (opts && opts.onRetry) {
                    opts.onRetry(e, currentFailureCount, waitForRequest);
                }
                await delay(waitForRequest);
            }
        }
    };
}

export let backoff = createBackoff({ onError: (e) => { console.warn(e); } });
export let backoffForever = createBackoff({ onError: (e) => { console.warn(e); }, maxFailureCount: Number.POSITIVE_INFINITY });
