import { startApi } from '@/app/api/api';
import { startMetricsServer } from '@/app/monitoring/metrics';
import { startDatabaseMetricsUpdater } from '@/app/monitoring/metrics2';
import { auth } from '@/app/auth/auth';
import { activityCache } from '@/app/presence/sessionCache';
import { startTimeout } from '@/app/presence/timeout';
import { initEncrypt } from '@/modules/encrypt';
import { initGithub } from '@/modules/github';
import { loadFiles, initFilesLocalFromEnv, initFilesS3FromEnv } from '@/storage/files';
import { db, initDbPostgres, initDbSqlite } from '@/storage/db';
import { log } from '@/utils/log';
import { awaitShutdown, onShutdown } from '@/utils/shutdown';
import { applyLightDefaultEnv, ensureHandyMasterSecret } from '@/flavors/light/env';

export type ServerFlavor = 'full' | 'light';

export async function startServer(flavor: ServerFlavor): Promise<void> {
    process.env.HAPPY_SERVER_FLAVOR = flavor;

    if (flavor === 'light') {
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        await initDbSqlite();
        initFilesLocalFromEnv(process.env);
    } else {
        initDbPostgres();
        initFilesS3FromEnv(process.env);
    }

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    });
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });

    if (flavor === 'full') {
        const { redis } = await import('./storage/redis');
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
