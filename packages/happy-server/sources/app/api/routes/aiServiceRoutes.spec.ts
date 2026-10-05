import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Fastify } from '../types';
import { createAIServiceStore } from '@/app/aiServices/store';
import { createTestDatabase } from '@/app/aiServices/testDatabase';
import { aiServiceRoutes } from './aiServiceRoutes';

describe('AI service HTTP boundaries', () => {
    let context: Awaited<ReturnType<typeof createTestDatabase>>;
    let app: Fastify;
    let owner: string;
    let config: object;
    let seq = 0;
    const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, user = owner) => app.inject({ method, url, payload, headers: user ? { authorization: `Bearer ${user}` } : {} });
    beforeAll(async () => {
        context = await createTestDatabase();
        app = fastify().withTypeProvider<ZodTypeProvider>() as Fastify;
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (req: any, reply: any) => {
            if (!req.headers.authorization?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });
            req.userId = req.headers.authorization.slice(7);
        });
        aiServiceRoutes(app, createAIServiceStore(context.database)); await app.ready();
    }, 120000);
    beforeEach(async () => {
        owner = `route-owner-${++seq}`;
        await context.database.account.create({ data: { id: owner, publicKey: owner } });
        await context.database.machine.create({ data: { id: `${owner}-machine`, accountId: owner, metadata: 'encrypted' } });
        await context.database.codexAccountProfile.create({ data: { id: `${owner}-profile`, accountId: owner, displayName: 'Work', externalAccountFingerprint: 'identity', credential: Buffer.from('never-expose-auth') } });
        config = { engine: 'codex', machineId: `${owner}-machine`, accountRef: { kind: 'codex-profile', id: `${owner}-profile` }, modelId: null, reasoning: { mode: 'default' } };
    });
    afterAll(async () => { await app?.close(); await context?.database.$disconnect(); await context?.pg.close(); });
    it('uses authenticated ownership and exposes safe configuration with CAS updates', async () => {
        expect((await request('POST', '/v1/ai-services', { name: 'Work', config }, '')).statusCode).toBe(401);
        const created = await request('POST', '/v1/ai-services', { name: 'Work', config });
        expect(created.statusCode, created.body).toBe(201);
        const id = created.json().service.id;
        expect((await request('GET', '/v1/ai-services')).json().services).toHaveLength(1);
        expect((await request('GET', `/v1/ai-services/${id}`)).json()).toMatchObject({ service: { revision: 1 }, revision: { config } });
        expect((await request('GET', `/v1/ai-services/${id}/authorizations`)).json()).toEqual({ grants: [] });
        expect((await request('GET', `/v1/ai-services/${id}/authorizations`, undefined, 'foreign-owner')).statusCode).toBe(404);
        expect((await request('PATCH', `/v1/ai-services/${id}`, { expectedRevision: 1, metadata: { name: 'Renamed' } })).json()).toMatchObject({ service: { name: 'Renamed', revision: 1 } });
        const updated = await request('PUT', `/v1/ai-services/${id}`, { expectedRevision: 1, config });
        expect(updated.statusCode, updated.body).toBe(200);
        expect((await request('PUT', `/v1/ai-services/${id}`, { expectedRevision: 1, config })).json()).toMatchObject({ error: { code: 'revision-conflict' } });
        expect((await request('GET', `/v1/ai-services/${id}`, undefined, 'foreign-owner')).statusCode).toBe(404);
        expect((await request('GET', '/v1/ai-services')).body).not.toContain('never-expose-auth');
        expect((await request('DELETE', `/v1/ai-services/${id}`, { expectedRevision: 2 })).statusCode).toBe(200);
        expect((await request('GET', '/v1/ai-services')).json().services).toEqual([]);
    });
    it('rejects asserted owner, credentials, origins, oversized input and arbitrary app registration', async () => {
        for (const extra of [{ ownerId: 'foreign-owner' }, { origins: ['https://evil.example'] }, { credential: 'secret' }]) {
            expect((await request('POST', '/v1/ai-services', { name: 'Work', config, ...extra })).statusCode).toBe(400);
        }
        expect((await request('POST', '/v1/ai-services', { name: 'x'.repeat(20000), config })).statusCode).toBe(413);
        expect((await request('POST', '/v1/apps/register', { appId: 'evil', origins: ['https://evil.example'] })).statusCode).toBe(404);
    });
    it('fails closed for scoped service lists until grant authentication exists', async () => {
        for (const query of ['', '?appId=relationship-advisor', '?appId=relationship-advisor&principal=owner&ownerId=foreign&profileId=stolen']) {
            const response = await request('GET', `/v1/apps/services${query}`);
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: { code: 'permission-denied', retryable: false } });
            expect(response.headers['cache-control']).toBe('no-store');
        }
    });
});
