export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
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
        shouldRetry?: (e: any, failuresCount: number) => boolean,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 8;
        const shouldRetry = opts && opts.shouldRetry
            ? opts.shouldRetry
            : (e: any) => {
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
                let waitForRequest = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                await delay(waitForRequest);
            }
        }
    };
}

export let backoff = createBackoff();
export let backoffForever = createBackoff({ maxFailureCount: Number.POSITIVE_INFINITY });