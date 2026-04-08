import path from "node:path";
import { startApi } from "@/app/api/api";
import { eventRouter } from "@/app/events/eventRouter";
import { startMetricsServer } from "@/app/monitoring/metrics";
import { startDatabaseMetricsUpdater } from "@/app/monitoring/metrics2";
import { auth } from "./app/auth/auth";
import { startTimeout } from "./app/presence/timeout";
import { activityCache } from "@/app/presence/sessionCache";
import { Backplane } from "@/modules/backplane/backplane";
import { createBackplane } from "@/modules/backplane/createBackplane";
import { validateStartup } from "@/modules/config/startupValidation";
import { initEncrypt } from "./modules/encrypt";
import { initGithub } from "./modules/github";
import { db } from './storage/db';
import { loadFiles } from "./storage/files";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";

export interface MainDependencies {
    db: {
        $connect(): Promise<void>;
        $disconnect(): Promise<void>;
    };
    createBackplane(): Promise<Backplane>;
    eventRouter: {
        init(backplane: Backplane): Promise<void>;
    };
    activityCache: {
        shutdown(): void;
    };
    validateStartup(backplane: Backplane): void;
    initEncrypt(): Promise<void>;
    initGithub(): Promise<void>;
    loadFiles(): Promise<void>;
    auth: {
        init(): Promise<void>;
    };
    startApi(backplane: Backplane): Promise<void>;
    startMetricsServer(): Promise<void>;
    startDatabaseMetricsUpdater(): void;
    startTimeout(): void;
    onShutdown(name: string, callback: () => Promise<void>): () => void;
    awaitShutdown(): Promise<void>;
    log(src: any, ...args: any[]): void;
}

const defaultDependencies: MainDependencies = {
    db,
    createBackplane,
    eventRouter,
    activityCache,
    validateStartup,
    initEncrypt,
    initGithub,
    loadFiles,
    auth,
    startApi,
    startMetricsServer,
    startDatabaseMetricsUpdater,
    startTimeout,
    onShutdown,
    awaitShutdown,
    log,
};

let processHandlersRegistered = false;

export function registerProcessHandlers(): void {
    if (processHandlersRegistered) {
        return;
    }
    processHandlersRegistered = true;

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
}

export async function runMain(deps: MainDependencies = defaultDependencies): Promise<void> {
    registerProcessHandlers();

    await deps.db.$connect();

    const backplane = await deps.createBackplane();
    await deps.eventRouter.init(backplane);

    // Shutdown handlers run in reverse registration order, so register core dependencies
    // from deepest to shallowest: db first, then backplane, then activity cache.
    deps.onShutdown('db', async () => {
        await deps.db.$disconnect();
    });
    deps.onShutdown('backplane', async () => {
        await backplane.destroy();
    });
    deps.onShutdown('activity-cache', async () => {
        deps.activityCache.shutdown();
    });

    deps.validateStartup(backplane);

    await deps.initEncrypt();
    await deps.initGithub();
    await deps.loadFiles();
    await deps.auth.init();

    await deps.startApi(backplane);
    await deps.startMetricsServer();
    deps.startDatabaseMetricsUpdater();
    deps.startTimeout();

    deps.log('Ready');
    await deps.awaitShutdown();
    deps.log('Shutting down...');
}

function isMainModule(): boolean {
    const entryPoint = process.argv[1];
    if (!entryPoint) {
        return false;
    }

    const entryFile = path.basename(entryPoint);
    return entryFile === 'main.ts' || entryFile === 'main.js';
}

if (isMainModule()) {
    runMain().catch((error) => {
        console.error(error);
        process.exit(1);
    }).then(() => {
        process.exit(0);
    });
}
