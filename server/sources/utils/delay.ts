import { warn } from "./log";

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    if (signal.aborted) {
        return;
    }
    
    await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, ms);
        
        const abortHandler = () => {
            clearTimeout(timeout);
            resolve();
        };
        
        if (signal.aborted) {
            clearTimeout(timeout);
            resolve();
        } else {
            signal.addEventListener('abort', abortHandler, { once: true });
        }
    });
}