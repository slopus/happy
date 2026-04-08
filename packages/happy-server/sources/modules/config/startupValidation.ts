import { Backplane } from "@/modules/backplane/backplane";
import { log, warn } from "@/utils/log";

export interface StartupBanner {
    dbProvider: string;
    redisStatus: 'connected' | 'not configured';
    fileStorage: 's3' | 'local';
    processId: string;
}

export interface StartupValidationResult {
    banner: StartupBanner;
    warnings: string[];
}

const LOCAL_STORAGE_WARNING = 'Redis is configured but file storage is local. Multi-pod deployments require S3 for shared file access. Affected: file uploads (uploadImage.ts), file serving (api.ts), avatar URLs (accountRoutes.ts). Set S3_HOST, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.';
const PGLITE_WARNING = 'PGlite is single-process only. Redis backplane will work but PGlite cannot be shared across pods. Use DB_PROVIDER=postgres for multi-pod.';
const HANDY_MASTER_SECRET_ERROR = 'HANDY_MASTER_SECRET must be set before starting happy-server. It is required for auth and encryption.';

function hasValue(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

export function getStartupValidationResult(
    processId: string,
    env: NodeJS.ProcessEnv = process.env,
): StartupValidationResult {
    if (!hasValue(env.HANDY_MASTER_SECRET)) {
        throw new Error(HANDY_MASTER_SECRET_ERROR);
    }

    const dbProvider = env.DB_PROVIDER || 'postgres';
    const redisConfigured = hasValue(env.REDIS_URL);
    const s3Configured = hasValue(env.S3_HOST);

    const warnings: string[] = [];
    if (redisConfigured && !s3Configured) {
        warnings.push(LOCAL_STORAGE_WARNING);
    }
    if (dbProvider === 'pglite' && redisConfigured) {
        warnings.push(PGLITE_WARNING);
    }

    return {
        banner: {
            dbProvider,
            redisStatus: redisConfigured ? 'connected' : 'not configured',
            fileStorage: s3Configured ? 's3' : 'local',
            processId,
        },
        warnings,
    };
}

export function validateStartup(
    backplane: Backplane,
    env: NodeJS.ProcessEnv = process.env,
): StartupValidationResult {
    const result = getStartupValidationResult(backplane.getProcessId(), env);

    log({
        module: 'startup',
        dbProvider: result.banner.dbProvider,
        redisStatus: result.banner.redisStatus,
        fileStorage: result.banner.fileStorage,
        processId: result.banner.processId,
    }, `Startup configuration: db=${result.banner.dbProvider}, redis=${result.banner.redisStatus}, fileStorage=${result.banner.fileStorage}, processId=${result.banner.processId}`);

    for (const warningMessage of result.warnings) {
        warn({
            module: 'startup',
            processId: result.banner.processId,
        }, warningMessage);
    }

    return result;
}

export const startupValidationMessages = {
    localStorageWarning: LOCAL_STORAGE_WARNING,
    pgliteWarning: PGLITE_WARNING,
    handyMasterSecretError: HANDY_MASTER_SECRET_ERROR,
};
