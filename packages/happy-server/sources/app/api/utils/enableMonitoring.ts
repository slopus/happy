import { db } from "@/storage/db";
import { Backplane } from "@/modules/backplane/backplane";
import { RedisBackplane } from "@/modules/backplane/redisBackplane";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram } from "@/app/monitoring/metrics2";
import { log } from "@/utils/log";

type RedisHealthStatus = 'ok' | 'error' | 'not configured';

async function getRedisHealthStatus(backplane?: Backplane): Promise<RedisHealthStatus> {
    if (!(backplane instanceof RedisBackplane)) {
        return 'not configured';
    }

    return (await backplane.isHealthy()) ? 'ok' : 'error';
}

export function enableMonitoring(app: Fastify, backplane?: Backplane) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status }, duration);
    });

    app.get('/health', async (request, reply) => {
        const timestamp = new Date().toISOString();
        const processId = backplane?.getProcessId() || 'unknown';
        const redis = await getRedisHealthStatus(backplane);

        try {
            await db.$queryRaw`SELECT 1`;
        } catch (error) {
            log({ module: 'health', level: 'error', processId, redis }, `Health check failed: ${error}`);
            reply.code(503).send({
                status: 'error',
                timestamp,
                service: 'happy-server',
                processId,
                redis,
                error: 'Database connectivity failed'
            });
            return;
        }

        if (redis === 'error') {
            log({ module: 'health', level: 'error', processId, redis }, 'Health check failed: Redis backplane connectivity failed');
            reply.code(503).send({
                status: 'error',
                timestamp,
                service: 'happy-server',
                processId,
                redis,
                error: 'Redis backplane connectivity failed'
            });
            return;
        }

        reply.send({
            status: 'ok',
            timestamp,
            service: 'happy-server',
            processId,
            redis,
        });
    });
}
