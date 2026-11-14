import { BotsLaunchRequestSchema, BotsLaunchResponseSchema } from '@slopus/happy-wire';
import { z } from 'zod';
import { BotsOriginError, launchBots } from '@/bots/botsGateway';
import type { Fastify } from '../types';

export function botsRoutes(app: Fastify, launch = launchBots) {
    app.post('/v1/bots/launch', {
        preHandler: app.authenticate,
        schema: {
            body: BotsLaunchRequestSchema,
            response: { 200: BotsLaunchResponseSchema, 403: z.object({ error: z.string() }), 503: z.object({ error: z.string() }) },
        },
    }, async (request, reply) => {
        const controller = new AbortController();
        const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(new Error('Client disconnected')); };
        reply.raw.once('close', disconnect);
        try {
            const result = await launch(request.userId, request.body, controller.signal);
            reply.header('Cache-Control', 'no-store');
            return reply.send(result);
        } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof BotsOriginError) return reply.code(403).send({ error: error.message });
            return reply.code(503).send({ error: 'Bots runtime is not available. Configure the private Rakazo gateway.' });
        } finally {
            reply.raw.removeListener('close', disconnect);
        }
    });
}
