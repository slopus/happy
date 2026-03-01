import { startApi } from "@/app/api/api";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/presence/timeout";
import { startMetricsServer } from "@/app/monitoring/metrics";
import { activityCache } from "@/app/presence/sessionCache";
import { auth } from "./app/auth/auth";
import { startDatabaseMetricsUpdater } from "@/app/monitoring/metrics2";
import { initEncrypt } from "./modules/encrypt";
import { initGithub } from "./modules/github";
import { loadFiles } from "./storage/files";

async function main() {

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    });
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });
    if (process.env.REDIS_URL) {
        const { Redis } = await import('ioredis');
        const redis = new Redis(process.env.REDIS_URL);
        await redis.ping();
    }

    // Initialize auth module
    await initEncrypt();
    await initGithub();
    await loadFiles();
    await auth.init();

    //
    // Start
    //

    await startApi();
    await startMetricsServer();
    startDatabaseMetricsUpdater();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

// Process-level error handling with recovery
let uncaughtExceptionCount = 0;
let unhandledRejectionCount = 0;
const MAX_ERRORS_BEFORE_EXIT = 5;
const ERROR_RESET_INTERVAL = 60000; // Reset counter after 1 minute

// Reset error counters periodically
setInterval(() => {
    uncaughtExceptionCount = 0;
    unhandledRejectionCount = 0;
}, ERROR_RESET_INTERVAL);

process.on('uncaughtException', (error) => {
    uncaughtExceptionCount++;

    log({
        module: 'process-error',
        level: 'error',
        stack: error.stack,
        name: error.name,
        errorCount: uncaughtExceptionCount
    }, `Uncaught Exception (${uncaughtExceptionCount}/${MAX_ERRORS_BEFORE_EXIT}): ${error.message}`);

    console.error('Uncaught Exception:', error);

    // Only exit if we've hit too many errors
    if (uncaughtExceptionCount >= MAX_ERRORS_BEFORE_EXIT) {
        console.error(`Too many uncaught exceptions (${uncaughtExceptionCount}). Exiting...`);
        process.exit(1);
    } else {
        console.warn(`Error recovered. Server continues running. (${uncaughtExceptionCount}/${MAX_ERRORS_BEFORE_EXIT})`);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    unhandledRejectionCount++;

    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    const errorStack = reason instanceof Error ? reason.stack : undefined;

    log({
        module: 'process-error',
        level: 'error',
        stack: errorStack,
        reason: String(reason),
        errorCount: unhandledRejectionCount
    }, `Unhandled Rejection (${unhandledRejectionCount}/${MAX_ERRORS_BEFORE_EXIT}): ${errorMsg}`);

    console.error('Unhandled Rejection at:', promise, 'reason:', reason);

    // Only exit if we've hit too many errors
    if (unhandledRejectionCount >= MAX_ERRORS_BEFORE_EXIT) {
        console.error(`Too many unhandled rejections (${unhandledRejectionCount}). Exiting...`);
        process.exit(1);
    } else {
        console.warn(`Promise rejection recovered. Server continues running. (${unhandledRejectionCount}/${MAX_ERRORS_BEFORE_EXIT})`);
    }
});

process.on('warning', (warning) => {
    log({
        module: 'process-warning',
        level: 'warn',
        name: warning.name,
        stack: warning.stack
    }, `Process Warning: ${warning.message}`);
});

// Log when the process is about to exit
process.on('exit', (code) => {
    if (code !== 0) {
        log({
            module: 'process-exit',
            level: 'error',
            exitCode: code
        }, `Process exiting with code: ${code}`);
    } else {
        log({
            module: 'process-exit',
            level: 'info',
            exitCode: code
        }, 'Process exiting normally');
    }
});

main().catch((e) => {
    console.error(e);
    process.exit(1);
}).then(() => {
    process.exit(0);
});