import { log } from "./log";

const shutdownHandlers = new Map<string, Array<() => Promise<void>>>();
const shutdownController = new AbortController();
let shutdownPromise: Promise<void> | null = null;

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

export async function runShutdownHandlers(): Promise<void> {
    if (shutdownPromise) {
        return shutdownPromise;
    }

    shutdownPromise = (async () => {
        shutdownController.abort();

        const handlersSnapshot = new Map<string, Array<() => Promise<void>>>();
        for (const [name, handlers] of shutdownHandlers) {
            handlersSnapshot.set(name, [...handlers]);
        }

        let totalHandlers = 0;
        for (const handlers of handlersSnapshot.values()) {
            totalHandlers += handlers.length;
        }

        if (totalHandlers === 0) {
            return;
        }

        log(`Waiting for ${totalHandlers} shutdown handlers to complete...`);
        const shutdownStartTime = Date.now();

        const shutdownGroups = Array.from(handlersSnapshot.entries()).reverse();
        for (const [name, handlers] of shutdownGroups) {
            log(`Starting ${handlers.length} shutdown handlers for: ${name}`);
            const groupStartTime = Date.now();

            await Promise.all(handlers.map((handler, index) => handler().then(
                () => {},
                (error) => log(`Error in shutdown handler ${name}[${index}]:`, error)
            )));

            const groupDuration = Date.now() - groupStartTime;
            log(`Completed ${handlers.length} shutdown handlers for: ${name} in ${groupDuration}ms`);
        }

        const shutdownDuration = Date.now() - shutdownStartTime;
        log(`All ${totalHandlers} shutdown handlers completed in ${shutdownDuration}ms`);
    })();

    return shutdownPromise;
}

export async function awaitShutdown() {
    await new Promise<void>((resolve) => {
        const handleSignal = (signal: 'SIGINT' | 'SIGTERM') => {
            log(`Received ${signal} signal. Exiting...`);
            process.off('SIGINT', handleSigint);
            process.off('SIGTERM', handleSigterm);
            resolve();
        };

        const handleSigint = () => handleSignal('SIGINT');
        const handleSigterm = () => handleSignal('SIGTERM');

        process.on('SIGINT', handleSigint);
        process.on('SIGTERM', handleSigterm);
    });

    await runShutdownHandlers();
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
