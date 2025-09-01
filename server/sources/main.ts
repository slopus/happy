import { startApi } from "@/app/api";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/timeout";
import { redis } from "./services/redis";
import { startMetricsServer } from "@/app/metrics";
import { activityCache } from "@/modules/sessionCache";
import { auth } from "./modules/auth";
import { startDatabaseMetricsUpdater } from "@/modules/metrics";
import { initEncrypt } from "./modules/encrypt";
import { initGithub } from "./modules/github";
import { loadFiles } from "./storage/files";
import { EventRouter } from "./modules/eventRouter";

async function main() {

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    });
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });
    await redis.ping();

    // Initialize auth module
    const eventRouter = new EventRouter();
    await initEncrypt();
    await initGithub();
    await loadFiles();
    await auth.init();

    //
    // Start
    //

    await startApi(eventRouter);
    await startMetricsServer();
    startDatabaseMetricsUpdater();
    startTimeout(eventRouter);

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

// Process-level error handling
process.on('uncaughtException', (error) => {
    log({
        module: 'process-error',
        level: 'error',
        stack: error.stack,
        name: error.name
    }, `Uncaught Exception: ${error.message}`);

    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    const errorStack = reason instanceof Error ? reason.stack : undefined;

    log({
        module: 'process-error',
        level: 'error',
        stack: errorStack,
        reason: String(reason)
    }, `Unhandled Rejection: ${errorMsg}`);

    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
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