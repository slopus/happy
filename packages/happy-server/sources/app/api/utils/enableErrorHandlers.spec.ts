import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn() }));

vi.mock('@/utils/log', () => ({ log: logMock }));

import { enableErrorHandlers, handleFrameworkError } from './enableErrorHandlers';

describe('enableErrorHandlers', () => {
    it('never writes authorization or cookie values to the 404 log', async () => {
        const app = fastify({ frameworkErrors: handleFrameworkError }) as unknown as Fastify;
        enableErrorHandlers(app);
        await app.ready();

        const response = await app.inject({
            method: 'GET',
            url: '/missing',
            headers: {
                authorization: `PawsShare ${'secret-management-token'}`,
                cookie: 'session=secret-cookie',
                'user-agent': 'safe-agent',
            },
        });

        expect(response.statusCode).toBe(404);
        const logged = JSON.stringify(logMock.mock.calls);
        expect(logged).not.toContain('secret-management-token');
        expect(logged).not.toContain('secret-cookie');
        expect(logged).not.toContain('Headers:');
    });

    it('maps invalid percent encoding on public share URLs to the generic not-found contract', async () => {
        const app = fastify({ frameworkErrors: handleFrameworkError }) as unknown as Fastify;
        app.get('/v1/public/session-shares/:publicId', async () => ({ ok: true }));
        enableErrorHandlers(app);
        await app.ready();

        const response = await app.inject({ method: 'GET', url: '/v1/public/session-shares/%ZZ' });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Shared session not found' });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    });
});
