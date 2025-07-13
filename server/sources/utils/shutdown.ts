import { log } from "./log";

let locks = 0;
let awaititers = new Array<() => void>();
let shutdown = false;

export function isShutdown() {
    return shutdown;
}

export function shutdownLock() {
    let locked = true;
    locks++;
    return () => {
        if (locked) {
            locks--;
            if (locks === 0) {
                for (let iter of awaititers) {
                    iter();
                }
            }
        };
    }
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
    shutdown = true;
    if (locks > 0) {
        await new Promise<void>((resolve) => {
            awaititers.push(resolve);
        });
    }
}