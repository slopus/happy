import fastify from 'fastify';
import { db } from '@/storage/db';
import { register } from '@/app/monitoring/metrics2';
import { log } from '@/utils/log';

export async function createMetricsServer() {
    const app = fastify({
        logger: false // Disable logging for metrics server
    });

    app.get('/metrics', async (_request, reply) => {
        try {
            // Get Prisma metrics in Prometheus format
            const prismaMetrics = await db.$metrics.prometheus();
            
            // Get custom application metrics
            const appMetrics = await register.metrics();
            
            // Combine both metrics
            const combinedMetrics = prismaMetrics + '\n' + appMetrics;
            
            reply.type('text/plain; version=0.0.4; charset=utf-8');
            reply.send(combinedMetrics);
        } catch (error) {
            log({ module: 'metrics', level: 'error' }, `Error generating metrics: ${error}`);
            reply.code(500).send('Internal Server Error');
        }
    });

    app.get('/health', async (_request, reply) => {
        reply.send({ status: 'ok', timestamp: new Date().toISOString() });
    });

    return app;
}

export async function startMetricsServer(): Promise<void> {
    const enabled = process.env.METRICS_ENABLED !== 'false';
    if (!enabled) {
        log({ module: 'metrics' }, 'Metrics server disabled');
        return;
    }

    const port = process.env.METRICS_PORT ? parseInt(process.env.METRICS_PORT, 10) : 9090;
    const app = await createMetricsServer();
    
    try {
        await app.listen({ port, host: '0.0.0.0' });
        log({ module: 'metrics' }, `Metrics server listening on port ${port}`);
    } catch (error) {
        log({ module: 'metrics', level: 'error' }, `Failed to start metrics server: ${error}`);
        throw error;
    }
}