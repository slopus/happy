import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { botsRoutes } from '../app/api/routes/botsRoutes';
import type { Fastify } from '../app/api/types';
import { BotsOriginError, BotsUnavailableError } from './botsGateway';

function create(launch = vi.fn(async () => ({ runtimeUrl: 'https://bots.test/', ticket: 't'.repeat(43), expiresAt: Date.now() + 60_000 }))) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: any, reply: any) => {
        if (request.headers.authorization !== 'Bearer valid') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = 'verified-alice';
    });
    botsRoutes(app as unknown as Fastify, launch);
    app.get('/health', async () => ({ ok: true }));
    return { app, launch };
}

describe('authenticated Bots launch route', () => {
    it('requires normal Paws auth and refuses client-supplied account IDs', async () => {
        const { app, launch } = create();
        try {
            const payload = { parentOrigin: 'https://paws.test', platform: 'web' };
            expect((await app.inject({ method: 'POST', url: '/v1/bots/launch', payload })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: '/v1/bots/launch', headers: { authorization: 'Bearer valid' }, payload: { ...payload, subject: 'bob' } })).statusCode).toBe(400);
            const result = await app.inject({ method: 'POST', url: '/v1/bots/launch', headers: { authorization: 'Bearer valid' }, payload });
            expect(result.statusCode).toBe(200);
            expect(result.headers['cache-control']).toBe('no-store');
            expect(launch).toHaveBeenCalledWith('verified-alice', payload, expect.any(AbortSignal));
        } finally { await app.close(); }
    });
    it('an unavailable gateway does not affect other Paws routes', async () => {
        const launch = vi.fn().mockRejectedValue(new BotsUnavailableError('not configured'));
        const { app } = create(launch);
        try {
            const result = await app.inject({ method: 'POST', url: '/v1/bots/launch', headers: { authorization: 'Bearer valid' }, payload: { parentOrigin: 'https://paws.test' } });
            expect(result.statusCode).toBe(503);
            expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
            launch.mockRejectedValueOnce(new BotsOriginError('Origin not allowed'));
            expect((await app.inject({ method: 'POST', url: '/v1/bots/launch', headers: { authorization: 'Bearer valid' }, payload: { parentOrigin: 'https://paws.test' } })).statusCode).toBe(403);
        } finally { await app.close(); }
    });
});
