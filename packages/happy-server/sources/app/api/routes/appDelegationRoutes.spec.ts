import fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '@/app/api/types';
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/app/appDelegation/appDelegation', async importOriginal => {
    const actual = await importOriginal<typeof import('@/app/appDelegation/appDelegation')>();
    return { ...actual, createAppPairing: vi.fn(async () => ({ id: 'test' })) };
});
import { appDelegationRoutes } from './appDelegationRoutes';
const server = fastify({ bodyLimit: 100 * 1024 * 1024 });
beforeAll(async () => {
    server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
    server.decorate('authenticate', async (_request: unknown, reply: any) => reply.code(401).send({ error: 'Unauthorized' }));
    appDelegationRoutes(server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify);
    await server.ready();
});
afterAll(() => server.close());
it('rejects oversized anonymous JSON before parsing the application schema', async () => {
    const result = await server.inject({ method: 'POST', url: '/v1/apps/pairings', payload: { data: 'x'.repeat(3000) } });
    expect(result.statusCode).toBe(413);
});
it('rejects an unregistered browser origin', async () => {
    const result = await server.inject({ method: 'POST', url: '/v1/apps/pairings', headers: { origin: 'https://unregistered.example' }, payload: {} });
    expect(result.statusCode).toBe(403);
});
it('rate limits anonymous pairing creation using request IP', async () => {
    const payload = { appId: 'relationship-advisor', publicKey: 'A'.repeat(43) + '=', challengeHash: 'a'.repeat(64) };
    let result;
    for (let i = 0; i < 11; i++) result = await server.inject({ method: 'POST', url: '/v1/apps/pairings', payload, remoteAddress: '192.0.2.20' });
    expect(result!.statusCode).toBe(429);
});
