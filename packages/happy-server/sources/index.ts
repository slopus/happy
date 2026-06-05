import "reflect-metadata";

import { db } from "./storage/db";
import { initEncrypt } from "./modules/encrypt";
import { initGithub } from "./modules/github";
import { loadFiles } from "./storage/files";
import { auth } from "./app/auth/auth";
import { activityCache } from "./app/presence/sessionCache";
import { startApi, StartApiOptions } from "./app/api/api";
import { startDatabaseMetricsUpdater } from "./app/monitoring/metrics2";
import { startTimeout } from "./app/presence/timeout";
import { onShutdown } from "./utils/shutdown";

export { runMigrations } from "./standalone";
export type { StartApiOptions } from "./app/api/api";

export interface StartServerOptions extends StartApiOptions {
    pgliteDir: string;
    masterSecret: string;
}

export async function startServer(opts: StartServerOptions): Promise<{ port: number; host: string }> {
    process.env.DB_PROVIDER = process.env.DB_PROVIDER || "pglite";
    process.env.PGLITE_DIR = opts.pgliteDir;
    process.env.HANDY_MASTER_SECRET = opts.masterSecret;

    await db.$connect();
    onShutdown("db", async () => {
        await db.$disconnect();
    });
    onShutdown("activity-cache", async () => {
        activityCache.shutdown();
    });

    await initEncrypt();
    await initGithub();
    await loadFiles();
    await auth.init();

    const { port, host } = await startApi({
        port: opts.port,
        host: opts.host,
        staticDir: opts.staticDir,
        injectHtmlConfig: opts.injectHtmlConfig,
    });
    startDatabaseMetricsUpdater();
    startTimeout();

    return { port, host };
}
