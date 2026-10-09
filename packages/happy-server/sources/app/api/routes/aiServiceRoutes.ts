import { z } from 'zod';
import { ServiceConfigSchema } from '@slopus/happy-wire';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';
import { sharedAIServices, type SharedAIServices } from '@/app/aiServices/composition';
import { sharedAIServiceRoutes } from './sharedAIServiceRoutes';
import { createAIServiceStore, CreateServiceSchema, ServiceMetadataSchema, AIServiceError, type AIServiceStore } from '@/app/aiServices/store';

const expectedRevision = z.number().int().positive();
const params = z.object({ id: z.string().min(1).max(256) }).strict();
export function aiServiceRoutes(app: Fastify, store: AIServiceStore = sharedAIServices.store, services?: SharedAIServices) {
    const composition = services ?? (store === sharedAIServices.store ? sharedAIServices : undefined);
    if (composition) sharedAIServiceRoutes(app, composition);
    app.register(async instance => {
        const routes = instance.withTypeProvider<ZodTypeProvider>();
        routes.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
        routes.setErrorHandler((error, _request, reply) => {
            if (error instanceof AIServiceError) {
                const status = error.code === 'service-not-found' || error.code === 'account-not-found' ? 404
                    : error.code === 'permission-denied' ? 403
                    : error.code === 'revision-conflict' || error.code === 'service-disabled' ? 409 : 400;
                return reply.code(status).send({ error: { code: error.code, retryable: error.retryable } });
            }
            const frameworkError = error as { statusCode?: number; validation?: unknown };
            const status = frameworkError.statusCode === 413 ? 413 : frameworkError.validation || frameworkError.statusCode === 400 ? 400 : 500;
            return reply.code(status).send({ error: { code: status === 500 ? 'internal-error' : 'invalid-request', retryable: false } });
        });
        routes.get('/v1/ai-services/authorizations', { preHandler: app.authenticate }, async request => ({ grants: await store.listAuthorizations(request.userId) }));
        routes.get('/v1/ai-services', { preHandler: app.authenticate }, async request => ({ services: await store.listServices(request.userId) }));
        routes.post('/v1/ai-services', { bodyLimit: 8192, preHandler: app.authenticate, schema: { body: CreateServiceSchema } }, async (request, reply) => {
            return reply.code(201).send({ service: await store.createService(request.userId, request.body) });
        });
        routes.get('/v1/ai-services/:id', { preHandler: app.authenticate, schema: { params } }, request => store.readService(request.userId, request.params.id));
        routes.get('/v1/ai-services/:id/authorizations', { preHandler: app.authenticate, schema: { params } }, async request => ({ grants: await store.listServiceAuthorizations(request.userId, request.params.id) }));
        routes.put('/v1/ai-services/:id', { bodyLimit: 8192, preHandler: app.authenticate, schema: { params, body: z.object({ expectedRevision, config: ServiceConfigSchema }).strict() } }, async request => ({ revision: await store.updateService(request.userId, request.params.id, request.body.expectedRevision, request.body.config) }));
        routes.patch('/v1/ai-services/:id', { bodyLimit: 2048, preHandler: app.authenticate, schema: { params, body: z.object({ expectedRevision, metadata: ServiceMetadataSchema }).strict() } }, async request => ({ service: await store.updateServiceMetadata(request.userId, request.params.id, request.body.expectedRevision, request.body.metadata) }));
        routes.delete('/v1/ai-services/:id', { bodyLimit: 1024, preHandler: app.authenticate, schema: { params, body: z.object({ expectedRevision }).strict() } }, async request => {
            await store.deleteService(request.userId, request.params.id, request.body.expectedRevision); return { deleted: true };
        });
        // T4 replaces this handler with credential authentication. Owner tokens and query fields are not app grants.
        if (!composition) routes.get('/v1/apps/services', async (_request, reply) => reply.code(401).send({ error: { code: 'permission-denied', retryable: false } }));
    });
}
