import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApiApp } from './api';
import { encodeSandboxCspMetadata } from './mcpAppSandboxSecurity';
import type { Fastify } from './types';

describe('startApi MCP App sandbox registration', () => {
    const originalEnvironment = { ...process.env };
    let app: Fastify | undefined;
    let staticDir: string | undefined;

    afterEach(async () => {
        await app?.close();
        app = undefined;
        if (staticDir) await rm(staticDir, { recursive: true, force: true });
        staticDir = undefined;
        process.env = { ...originalEnvironment };
    });

    it('injects the real API routes without CORS, SPA fallback, or request-metadata logs', async () => {
        process.env.NODE_ENV = 'production';
        process.env.HAPPY_MCP_APP_SANDBOX_ORIGIN = 'https://sandbox.paws.example';
        process.env.HAPPY_MCP_APP_PARENT_ORIGINS = 'https://paws.example';
        const logs: string[] = [];
        const loggerInstance = pino({ level: 'trace' }, {
            write(chunk: string) { logs.push(chunk); },
        });
        const csp = encodeSandboxCspMetadata({
            connectDomains: ['https://api.integration.internal.example'],
            resourceDomains: [],
            frameDomains: [],
        }, false)!;
        staticDir = await mkdtemp(join(tmpdir(), 'paws-mcp-sandbox-api-'));
        await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>SPA fallback canary</title>');
        app = await createApiApp({ loggerInstance, staticDir });

        const responses = await Promise.all([
            app.inject({
                method: 'GET',
                url: `/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fpaws.example&csp=${csp}`,
                headers: { host: 'sandbox.paws.example' },
            }),
            app.inject({
                method: 'GET',
                url: `/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fparent-integration-secret.example&csp=${csp}`,
                headers: { host: 'sandbox.paws.example' },
            }),
            app.inject({
                method: 'GET',
                url: `/mcp-app-sandbox/unknown?parentOrigin=https%3A%2F%2Fparent-integration-secret.example&csp=${csp}`,
                headers: { host: 'sandbox.paws.example', origin: 'https://attacker.example' },
            }),
            app.inject({
                method: 'POST',
                url: `/mcp-app-sandbox/host.js?parentOrigin=https%3A%2F%2Fparent-integration-secret.example&csp=${csp}`,
                headers: { host: 'sandbox.paws.example', origin: 'https://attacker.example' },
            }),
            app.inject({
                method: 'OPTIONS',
                url: `/mcp-app-sandbox/unknown?parentOrigin=https%3A%2F%2Fparent-integration-secret.example&csp=${csp}`,
                headers: {
                    host: 'sandbox.paws.example',
                    origin: 'https://attacker.example',
                    'access-control-request-method': 'GET',
                },
            }),
        ]);

        expect(responses.map((response) => response.statusCode)).toEqual([200, 404, 404, 404, 404]);
        for (const response of responses.slice(1)) {
            expect(response.headers['cache-control']).toBe('no-store');
            expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
            expect(response.json()).toEqual({ error: 'Not found' });
        }
        const ordinarySpaRoute = await app.inject({ method: 'GET', url: '/conversation/session-id' });
        expect(ordinarySpaRoute.statusCode).toBe(200);
        expect(ordinarySpaRoute.body).toContain('SPA fallback canary');

        const captured = logs.join('');
        expect(captured).not.toContain('parent-integration-secret.example');
        expect(captured).not.toContain('api.integration.internal.example');
        expect(captured).not.toContain(csp);
        expect(captured).not.toContain('/mcp-app-sandbox/host?');
        expect(captured).not.toContain('/mcp-app-sandbox/unknown?');
        expect(captured).toContain('/conversation/session-id');
    });

    it('contains malformed percent URLs only inside the literal sandbox namespace', async () => {
        process.env.NODE_ENV = 'production';
        process.env.HAPPY_MCP_APP_SANDBOX_ORIGIN = 'https://sandbox.paws.example';
        process.env.HAPPY_MCP_APP_PARENT_ORIGINS = 'https://paws.example';
        const logs: string[] = [];
        const loggerInstance = pino({ level: 'trace' }, {
            write(chunk: string) { logs.push(chunk); },
        });
        const csp = encodeSandboxCspMetadata({
            connectDomains: ['https://framework.internal.example'],
            resourceDomains: [],
            frameDomains: [],
        }, false)!;
        app = await createApiApp({ loggerInstance });
        const sandboxQuery = `parentOrigin=https%3A%2F%2Fsandbox-framework-secret.example&csp=${csp}`;

        const sandboxResponses = await Promise.all(['GET', 'HEAD', 'OPTIONS', 'POST'].map((method) => (
            app!.inject({
                method: method as 'GET',
                url: `/mcp-app-sandbox/%zz?${sandboxQuery}`,
                headers: {
                    host: 'sandbox.paws.example',
                    origin: 'https://attacker.example',
                    'access-control-request-method': 'GET',
                },
            })
        )));

        for (const [index, response] of sandboxResponses.entries()) {
            expect(response.statusCode).toBe(404);
            expect(response.headers['cache-control']).toBe('no-store');
            expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
            if (index !== 1) expect(response.json()).toEqual({ error: 'Not found' });
            expect(response.body).not.toContain('sandbox-framework-secret');
            expect(response.body).not.toContain(csp);
        }

        const unrelated = await app.inject({
            method: 'GET',
            url: '/unrelated/%zz?canary=unrelated-framework-canary',
            headers: { host: 'sandbox.paws.example' },
        });
        const dashLookalike = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox-evil/%zz?canary=dash-lookalike-canary',
            headers: { host: 'sandbox.paws.example' },
        });
        const encodedSlashLookalike = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox%2F%zz?canary=encoded-lookalike-canary',
            headers: { host: 'sandbox.paws.example' },
        });

        for (const response of [unrelated, dashLookalike, encodedSlashLookalike]) {
            expect(response.statusCode).toBe(400);
            expect(response.headers['cache-control']).toBeUndefined();
            expect(response.json().code).toBe('FST_ERR_BAD_URL');
        }

        const captured = logs.join('');
        expect(captured).not.toContain('sandbox-framework-secret.example');
        expect(captured).not.toContain('framework.internal.example');
        expect(captured).not.toContain(csp);
        expect(captured).not.toContain('/mcp-app-sandbox/%zz?');
        expect(captured).toContain('unrelated-framework-canary');
        expect(captured).toContain('dash-lookalike-canary');
        expect(captured).toContain('encoded-lookalike-canary');
    });
});
