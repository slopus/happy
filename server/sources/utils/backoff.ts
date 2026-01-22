import { AbortedExeption } from "./aborted";
import { delay } from "./delay";
import { warn } from "./log";

function exponentialRandomizedBackoffDelay(failureCount: number, minDelay: number, maxDelay: number, factor = 0.5) {
    const exponentialDelay = Math.min(maxDelay, minDelay * Math.pow(2, failureCount));
    const jitterRange = exponentialDelay * factor;
    const randomJitter = (Math.random() * 2 - 1) * jitterRange;
    const delayWithJitter = exponentialDelay + randomJitter;
    return Math.floor(Math.max(minDelay, Math.min(maxDelay, delayWithJitter)));
}

type BackoffFunc = <T>(callback: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

export function createBackoff(
    opts?: {
        minDelay?: number,
        maxDelay?: number,
        factor?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 10000;
        const factor = opts && opts.factor !== undefined ? opts.factor : 0.5;
        while (true) {
            try {
                return await callback();
            } catch (e: any) {
                // Check if error is due to abort
                if (AbortedExeption.isAborted(e)) {
                    throw e;
                }
                warn(e);
                let waitForRequest = exponentialRandomizedBackoffDelay(currentFailureCount, minDelay, maxDelay, factor);
                await delay(waitForRequest, signal);
            }
        }
    };
}

export let backoff = createBackoff();