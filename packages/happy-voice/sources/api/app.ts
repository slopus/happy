import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { env } from '../runtime/env';
import { registerRoutes } from './routes';
import { logInfo } from '../runtime/log';

export async function startApiServer() {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'POST'],
    });

    registerRoutes(app);

    await app.listen({ host: env.HOST, port: env.PORT });
    logInfo(`API listening on http://${env.HOST}:${env.PORT}`);
}
