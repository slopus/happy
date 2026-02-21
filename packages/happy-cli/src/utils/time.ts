export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    let maxDelayRet = minDelay + ((maxDelay - minDelay) / maxFailureCount) * Math.min(currentFailureCount, maxFailureCount);
    return Math.round(Math.random() * maxDelayRet);
}

export class BackoffGaveUpError extends Error {
    readonly lastError: unknown;
    readonly attempts: number;
    constructor(lastError: unknown, attempts: number) {
        super(`Backoff gave up after ${attempts} attempts: ${lastError}`);
        this.name = 'BackoffGaveUpError';
        this.lastError = lastError;
        this.attempts = attempts;
    }
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export function createBackoff(
    opts?: {
        onError?: (e: any, failuresCount: number) => void,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number,
        maxRetries?: number,
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let totalAttempts = 0;
        let delayFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 50;
        const maxRetries = opts && opts.maxRetries !== undefined ? opts.maxRetries : undefined;
        while (true) {
            try {
                return await callback();
            } catch (e) {
                totalAttempts++;
                if (delayFailureCount < maxFailureCount) {
                    delayFailureCount++;
                }
                if (maxRetries !== undefined && totalAttempts >= maxRetries) {
                    throw new BackoffGaveUpError(e, totalAttempts);
                }
                if (opts && opts.onError) {
                    opts.onError(e, totalAttempts);
                }
                let waitForRequest = exponentialBackoffDelay(delayFailureCount, minDelay, maxDelay, maxFailureCount);
                await delay(waitForRequest);
            }
        }
    };
}

export let backoff = createBackoff();
