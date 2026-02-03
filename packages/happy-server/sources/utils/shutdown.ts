import { log } from "./log";

const shutdownHandlers = new Map<string, Array<() => Promise<void>>>();
const shutdownController = new AbortController();

export const shutdownSignal = shutdownController.signal;

export function onShutdown(name: string, callback: () => Promise<void>): () => void {
    if (shutdownSignal.aborted) {
        // If already shutting down, execute immediately
        callback();
        return () => {};
    }
    
    if (!shutdownHandlers.has(name)) {
        shutdownHandlers.set(name, []);
    }
    const handlers = shutdownHandlers.get(name)!;
    handlers.push(callback);
    
    // Return unsubscribe function
    return () => {
        const index = handlers.indexOf(callback);
        if (index !== -1) {
            handlers.splice(index, 1);
            if (handlers.length === 0) {
                shutdownHandlers.delete(name);
            }
        }
    };
}

export function isShutdown() {
    return shutdownSignal.aborted;
}

export async function awaitShutdown() {
    await new Promise<void>((resolve) => {
        process.on('SIGINT', async () => {
            log('Received SIGINT signal. Exiting...');
            resolve();
        });
        process.on('SIGTERM', async () => {
            log('Received SIGTERM signal. Exiting...');
            resolve();
        });
    });
    shutdownController.abort();
    
    // Copy handlers to avoid race conditions
    const handlersSnapshot = new Map<string, Array<() => Promise<void>>>();
    for (const [name, handlers] of shutdownHandlers) {
        handlersSnapshot.set(name, [...handlers]);
    }
    
    // Execute all shutdown handlers concurrently
    const allHandlers: Promise<void>[] = [];
    let totalHandlers = 0;
    
    for (const [name, handlers] of handlersSnapshot) {
        totalHandlers += handlers.length;
        log(`Starting ${handlers.length} shutdown handlers for: ${name}`);
        
        handlers.forEach((handler, index) => {
            const handlerPromise = handler().then(
                () => {},
                (error) => log(`Error in shutdown handler ${name}[${index}]:`, error)
            );
            allHandlers.push(handlerPromise);
        });
    }
    
    if (totalHandlers > 0) {
        log(`Waiting for ${totalHandlers} shutdown handlers to complete...`);
        const startTime = Date.now();
        await Promise.all(allHandlers);
        const duration = Date.now() - startTime;
        log(`All ${totalHandlers} shutdown handlers completed in ${duration}ms`);
    }
}

export async function keepAlive<T>(name: string, callback: () => Promise<T>): Promise<T> {
    let completed = false;
    let result: T;
    let error: any;
    
    const promise = new Promise<void>((resolve) => {
        const unsubscribe = onShutdown(`keepAlive:${name}`, async () => {
            if (!completed) {
                log(`Waiting for keepAlive operation to complete: ${name}`);
                await promise;
            }
        });
        
        // Run the callback
        callback().then(
            (res) => {
                result = res;
                completed = true;
                unsubscribe();
                resolve();
            },
            (err) => {
                error = err;
                completed = true;
                unsubscribe();
                resolve();
            }
        );
    });
    
    // Wait for completion
    await promise;
    
    if (error) {
        throw error;
    }
    
    return result!;
}