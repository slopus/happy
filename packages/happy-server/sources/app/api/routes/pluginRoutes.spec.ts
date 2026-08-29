import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Fastify } from '@/app/api/types';
import { pluginRoutes } from '@/app/api/routes/pluginRoutes';

async function createApp(registry: Parameters<typeof pluginRoutes>[1]) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    pluginRoutes(typed, registry);
    await typed.ready();
    return typed;
}

describe('pluginRoutes', () => {
    let app: Fastify | undefined;

    afterEach(async () => {
        if (app) await app.close();
        app = undefined;
        vi.clearAllMocks();
    });

    it('returns the authenticated account catalog from one generic endpoint', async () => {
        const list = vi.fn(async () => ({ plugins: [] }));
        app = await createApp({
            list,
            get: vi.fn(),
            install: vi.fn(),
            testConnection: vi.fn(),
            uninstall: vi.fn(),
        });

        const response = await app.inject({
            method: 'GET', url: '/v1/plugins', headers: { 'x-user-id': 'user-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ plugins: [] });
        expect(list).toHaveBeenCalledWith('user-1');
    });

    it('forwards a versioned installation request and never adds executable input', async () => {
        const install = vi.fn(async () => ({
            installed: true as const,
            version: '1.0.0',
            configuration: {},
            secretHints: {},
        }));
        app = await createApp({
            list: vi.fn(),
            get: vi.fn(),
            install,
            testConnection: vi.fn(),
            uninstall: vi.fn(),
        });

        const response = await app.inject({
            method: 'PUT',
            url: '/v1/plugins/generated-images-gallery',
            headers: { 'x-user-id': 'user-2' },
            payload: { version: '1.0.0', configuration: {} },
        });

        expect(response.statusCode).toBe(200);
        expect(install).toHaveBeenCalledWith('user-2', 'generated-images-gallery', {
            version: '1.0.0', configuration: {},
        });
    });

    it('maps registry errors to stable HTTP status codes', async () => {
        app = await createApp({
            list: vi.fn(),
            get: vi.fn(),
            install: vi.fn(async () => {
                const error = new Error('Installed version is stale') as Error & { code: string };
                error.code = 'version_mismatch';
                throw error;
            }),
            testConnection: vi.fn(),
            uninstall: vi.fn(),
        });

        const response = await app.inject({
            method: 'PUT',
            url: '/v1/plugins/relationship-advisor',
            headers: { 'x-user-id': 'user-3' },
            payload: { version: '0.9.0', configuration: {} },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'version_mismatch', message: 'Installed version is stale' });
    });

    it('tests a plugin configuration without installing it', async () => {
        const testConnection = vi.fn(async () => ({ success: true as const, latencyMs: 18 }));
        app = await createApp({
            list: vi.fn(),
            get: vi.fn(),
            install: vi.fn(),
            testConnection,
            uninstall: vi.fn(),
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/plugins/relationship-advisor/test-connection',
            headers: { 'x-user-id': 'user-4' },
            payload: {
                version: '1.1.1',
                configuration: {
                    apiKey: 'secret',
                    baseUrl: 'https://api.example.com/v1',
                    model: 'fast-model',
                },
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true, latencyMs: 18 });
        expect(testConnection).toHaveBeenCalledWith('user-4', 'relationship-advisor', {
            version: '1.1.1',
            configuration: {
                apiKey: 'secret',
                baseUrl: 'https://api.example.com/v1',
                model: 'fast-model',
            },
        });
    });
});
