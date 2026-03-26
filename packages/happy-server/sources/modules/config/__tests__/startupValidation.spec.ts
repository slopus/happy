import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backplane } from "@/modules/backplane/backplane";
import {
    getStartupValidationResult,
    startupValidationMessages,
    validateStartup,
} from "../startupValidation";
import { log, warn } from "@/utils/log";

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
    warn: vi.fn(),
}));

function createBackplane(processId = 'process-1'): Backplane {
    return {
        publish: vi.fn(async () => {}),
        subscribe: vi.fn(async () => {}),
        unsubscribe: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        isHealthy: vi.fn(async () => true),
        getProcessId: vi.fn(() => processId),
    };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('startupValidation', () => {
    it('warns when Redis is configured without S3-backed file storage', () => {
        const backplane = createBackplane();

        const result = validateStartup(backplane, {
            HANDY_MASTER_SECRET: 'secret',
            REDIS_URL: 'redis://localhost:6379',
            DB_PROVIDER: 'postgres',
        });

        expect(result.warnings).toEqual([startupValidationMessages.localStorageWarning]);
        expect(result.banner).toEqual({
            dbProvider: 'postgres',
            redisStatus: 'connected',
            fileStorage: 'local',
            processId: 'process-1',
        });
        expect(log).toHaveBeenCalledWith({
            module: 'startup',
            dbProvider: 'postgres',
            redisStatus: 'connected',
            fileStorage: 'local',
            processId: 'process-1',
        }, 'Startup configuration: db=postgres, redis=connected, fileStorage=local, processId=process-1');
        expect(warn).toHaveBeenCalledWith({
            module: 'startup',
            processId: 'process-1',
        }, startupValidationMessages.localStorageWarning);
    });

    it('warns when pglite is combined with Redis', () => {
        const backplane = createBackplane();

        const result = validateStartup(backplane, {
            HANDY_MASTER_SECRET: 'secret',
            REDIS_URL: 'redis://localhost:6379',
            S3_HOST: 'minio.local',
            DB_PROVIDER: 'pglite',
        });

        expect(result.warnings).toEqual([startupValidationMessages.pgliteWarning]);
        expect(result.banner).toEqual({
            dbProvider: 'pglite',
            redisStatus: 'connected',
            fileStorage: 's3',
            processId: 'process-1',
        });
        expect(warn).toHaveBeenCalledWith({
            module: 'startup',
            processId: 'process-1',
        }, startupValidationMessages.pgliteWarning);
    });

    it('throws a helpful error when HANDY_MASTER_SECRET is missing', () => {
        expect(() => getStartupValidationResult('process-1', {
            DB_PROVIDER: 'postgres',
        })).toThrow(startupValidationMessages.handyMasterSecretError);
        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not emit warnings for a valid multi-pod configuration', () => {
        const backplane = createBackplane('process-7');

        const result = validateStartup(backplane, {
            HANDY_MASTER_SECRET: 'secret',
            DB_PROVIDER: 'postgres',
            REDIS_URL: 'redis://localhost:6379',
            S3_HOST: 'minio.local',
        });

        expect(result.warnings).toEqual([]);
        expect(result.banner).toEqual({
            dbProvider: 'postgres',
            redisStatus: 'connected',
            fileStorage: 's3',
            processId: 'process-7',
        });
        expect(warn).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledTimes(1);
    });

    it('reports single-process defaults when Redis is not configured', () => {
        const result = getStartupValidationResult('process-9', {
            HANDY_MASTER_SECRET: 'secret',
        });

        expect(result).toEqual({
            banner: {
                dbProvider: 'postgres',
                redisStatus: 'not configured',
                fileStorage: 'local',
                processId: 'process-9',
            },
            warnings: [],
        });
    });
});
