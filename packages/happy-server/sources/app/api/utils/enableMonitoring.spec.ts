import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisBackplane } from "@/modules/backplane/redisBackplane";
import { MemoryBackplane } from "@/modules/backplane/memoryBackplane";
import type { Backplane } from "@/modules/backplane/backplane";
import { enableMonitoring } from "./enableMonitoring";
import { log } from "@/utils/log";

const {
    queryRawMock,
    counterIncMock,
    histogramObserveMock,
    logMock,
} = vi.hoisted(() => ({
    queryRawMock: vi.fn(),
    counterIncMock: vi.fn(),
    histogramObserveMock: vi.fn(),
    logMock: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        $queryRaw: queryRawMock,
    },
}));

vi.mock('@/app/monitoring/metrics2', () => ({
    httpRequestsCounter: {
        inc: counterIncMock,
    },
    httpRequestDurationHistogram: {
        observe: histogramObserveMock,
    },
}));

vi.mock('@/utils/log', () => ({
    log: logMock,
}));

function createRedisBackplane(processId: string, healthy: boolean): Backplane {
    return Object.assign(Object.create(RedisBackplane.prototype), {
        getProcessId: vi.fn(() => processId),
        isHealthy: vi.fn(async () => healthy),
    }) as Backplane;
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('enableMonitoring /health', () => {
    it('includes redis ok and processId for healthy Redis backplanes', async () => {
        queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
        const app = fastify();
        const backplane = createRedisBackplane('redis-process-1', true);
        enableMonitoring(app as any, backplane);

        const response = await app.inject({
            method: 'GET',
            url: '/health',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: 'ok',
            service: 'happy-server',
            processId: 'redis-process-1',
            redis: 'ok',
        });
        expect(counterIncMock).toHaveBeenCalledWith({
            method: 'GET',
            route: '/health',
            status: '200',
        });
        expect(histogramObserveMock).toHaveBeenCalledTimes(1);

        await app.close();
    });

    it('returns 503 when the Redis backplane is unhealthy', async () => {
        queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
        const app = fastify();
        const backplane = createRedisBackplane('redis-process-2', false);
        enableMonitoring(app as any, backplane);

        const response = await app.inject({
            method: 'GET',
            url: '/health',
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
            status: 'error',
            service: 'happy-server',
            processId: 'redis-process-2',
            redis: 'error',
            error: 'Redis backplane connectivity failed',
        });
        expect(log).toHaveBeenCalledWith({
            module: 'health',
            level: 'error',
            processId: 'redis-process-2',
            redis: 'error',
        }, 'Health check failed: Redis backplane connectivity failed');

        await app.close();
    });

    it('reports not configured for memory backplanes', async () => {
        queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
        const app = fastify();
        const backplane = new MemoryBackplane();
        enableMonitoring(app as any, backplane);

        const response = await app.inject({
            method: 'GET',
            url: '/health',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: 'ok',
            service: 'happy-server',
            processId: backplane.getProcessId(),
            redis: 'not configured',
        });

        await app.close();
    });

    it('returns 503 when the database health check fails', async () => {
        queryRawMock.mockRejectedValue(new Error('database unavailable'));
        const app = fastify();
        const backplane = new MemoryBackplane();
        enableMonitoring(app as any, backplane);

        const response = await app.inject({
            method: 'GET',
            url: '/health',
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
            status: 'error',
            service: 'happy-server',
            processId: backplane.getProcessId(),
            redis: 'not configured',
            error: 'Database connectivity failed',
        });
        expect(log).toHaveBeenCalledWith({
            module: 'health',
            level: 'error',
            processId: backplane.getProcessId(),
            redis: 'not configured',
        }, 'Health check failed: Error: database unavailable');

        await app.close();
    });
});
