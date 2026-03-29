import { warn } from "./log";

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    if (signal.aborted) {
        return;
    }
    
    await new Promise<void>((resolve) => {
        const abortHandler = () => {
            clearTimeout(timeout);
            resolve();
        };

        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', abortHandler);
            resolve();
        }, ms);

        if (signal.aborted) {
            clearTimeout(timeout);
            resolve();
        } else {
            signal.addEventListener('abort', abortHandler, { once: true });
        }
    });
}