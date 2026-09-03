import fastify from 'fastify';
import cors from '@fastify/cors';
import pino, { type Logger } from 'pino';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Fastify } from '@/app/api/types';
import { encodeSandboxCspMetadata } from '@/app/api/mcpAppSandboxSecurity';
import { mcpAppSandboxRoutes } from './mcpAppSandboxRoutes';
import { MCP_APP_SANDBOX_HOST_JAVASCRIPT } from '../generated/mcpAppHostShellAssets';

const sandboxOrigin = 'https://sandbox.paws.example';
const parentOrigin = 'https://paws.example';
const allowedParentOrigins = [parentOrigin];

function buildHostUrl(csp: string, parent = parentOrigin): string {
    return `/mcp-app-sandbox/host?parentOrigin=${encodeURIComponent(parent)}&csp=${encodeURIComponent(csp)}`;
}

async function createApp(
    overrides: Partial<Parameters<typeof mcpAppSandboxRoutes>[1]> = {},
    loggerInstance?: Logger,
) {
    const app = fastify(loggerInstance ? { loggerInstance } : {});
    await app.register(cors, { origin: '*' });
    mcpAppSandboxRoutes(app as unknown as Fastify, {
        sandboxOrigin,
        allowedParentOrigins,
        development: false,
        ...overrides,
    });
    await app.ready();
    return app as unknown as Fastify;
}

describe('mcpAppSandboxRoutes', () => {
    let app: Fastify | undefined;

    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it.each([
        'https://paws.example?mode=1',
        'https://paws.example?',
        'https://paws.example#section',
        'https://paws.example#',
    ])('generated proxy rejects a raw parent-origin delimiter before announcing ready: %s', (rawParentOrigin) => {
        const postMessage = vi.fn();
        const parent = { postMessage };
        const proxyWindow: Record<string, unknown> = {
            location: {
                href: `https://sandbox.paws.example/mcp-app-sandbox/host?parentOrigin=${encodeURIComponent(rawParentOrigin)}`,
            },
            parent,
            top: parent,
            console,
        };

        runInNewContext(MCP_APP_SANDBOX_HOST_JAVASCRIPT, {
            window: proxyWindow,
            document: { referrer: 'https://paws.example/tool' },
            URL,
            TextEncoder,
            console,
            setTimeout,
            clearTimeout,
        });

        expect(postMessage).not.toHaveBeenCalled();
        expect(proxyWindow).not.toHaveProperty('ReactNativeWebView');
    });

    it('serves the external Host Shell only for the exact sandbox and parent origins', async () => {
        const csp = encodeSandboxCspMetadata({
            connectDomains: ['https://api.allowed.example'],
            resourceDomains: ['https://cdn.allowed.example'],
            frameDomains: ['https://frame.allowed.example'],
        }, false)!;
        app = await createApp();

        const response = await app.inject({
            method: 'GET',
            url: buildHostUrl(csp),
            headers: { host: 'sandbox.paws.example', origin: parentOrigin },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), clipboard-write=()');
        expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.body).toContain('<script src="/mcp-app-sandbox/host.js" defer></script>');
        expect(response.body).not.toMatch(/<script(?![^>]+src=)[^>]*>/);

        const policy = response.headers['content-security-policy'];
        expect(policy).toBe([
            "default-src 'none'",
            "script-src 'self' 'unsafe-inline' https://cdn.allowed.example",
            "style-src 'unsafe-inline' https://cdn.allowed.example",
            'img-src data: blob: https://cdn.allowed.example',
            'media-src blob: https://cdn.allowed.example',
            'font-src data: https://cdn.allowed.example',
            'connect-src https://api.allowed.example',
            "frame-src 'self' https://frame.allowed.example",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            `frame-ancestors ${parentOrigin}`,
        ].join('; '));
        expect(policy).not.toContain('undeclared.example');
    });

    it('uses restrictive none directives when no external domains are declared', async () => {
        const csp = encodeSandboxCspMetadata({
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
        }, false)!;
        app = await createApp();

        const response = await app.inject({
            method: 'GET',
            url: buildHostUrl(csp),
            headers: { host: 'sandbox.paws.example' },
        });

        expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
        expect(response.headers['content-security-policy']).toContain("img-src data: blob:");
        expect(response.headers['content-security-policy']).toContain("frame-src 'self'");
    });

    it.each([
        ['wrong host', { host: 'paws.example' }, parentOrigin],
        ['lookalike host', { host: 'sandbox.paws.example.evil.test' }, parentOrigin],
        ['unexpected parent', { host: 'sandbox.paws.example' }, 'https://evil.example'],
    ])('returns an indistinguishable no-store 404 for %s', async (_label, headers, parent) => {
        const csp = encodeSandboxCspMetadata({ connectDomains: [], resourceDomains: [], frameDomains: [] }, false)!;
        app = await createApp();

        const response = await app.inject({
            method: 'GET',
            url: buildHostUrl(csp, parent),
            headers,
        });

        expect(response.statusCode).toBe(404);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({ error: 'Not found' });
        expect(response.body).not.toContain(parentOrigin);
        expect(response.body).not.toContain(sandboxOrigin);
    });

    it('returns the same 404 when configuration or CSP input is missing or invalid', async () => {
        app = await createApp({ sandboxOrigin: undefined, allowedParentOrigins: [] });
        const missingConfig = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fpaws.example&csp=bad',
            headers: { host: 'sandbox.paws.example' },
        });
        await app.close();

        app = await createApp();
        const invalidCsp = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fpaws.example&csp=bad',
            headers: { host: 'sandbox.paws.example' },
        });

        expect(missingConfig.statusCode).toBe(404);
        expect(invalidCsp.statusCode).toBe(404);
        expect(missingConfig.body).toBe(invalidCsp.body);
        expect(missingConfig.headers['cache-control']).toBe('no-store');
        expect(invalidCsp.headers['cache-control']).toBe('no-store');
    });

    it('parses escaped exact-origin query values without broad matching', async () => {
        const csp = encodeSandboxCspMetadata({ connectDomains: [], resourceDomains: [], frameDomains: [] }, false)!;
        app = await createApp();

        const accepted = await app.inject({
            method: 'GET',
            url: buildHostUrl(csp, 'https://paws.example:443'),
            headers: { host: 'sandbox.paws.example:443' },
        });
        const rejected = await app.inject({
            method: 'GET',
            url: buildHostUrl(csp, 'https://paws.example.evil.test'),
            headers: { host: 'sandbox.paws.example' },
        });

        expect(accepted.statusCode).toBe(200);
        expect(rejected.statusCode).toBe(404);
    });

    it('serves JavaScript only on the configured host with no CORS or configuration disclosure', async () => {
        app = await createApp();

        const accepted = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox/host.js',
            headers: { host: 'sandbox.paws.example', origin: 'https://attacker.example' },
        });
        const rejected = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox/host.js',
            headers: { host: 'paws.example' },
        });

        expect(accepted.statusCode).toBe(200);
        expect(accepted.headers['content-type']).toBe('text/javascript; charset=utf-8');
        expect(accepted.headers['cache-control']).toBe('no-store');
        expect(accepted.headers['x-content-type-options']).toBe('nosniff');
        expect(accepted.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(accepted.headers['access-control-allow-origin']).toBeUndefined();
        expect(accepted.body).toContain('parentOrigin');
        expect(accepted.body).not.toContain(parentOrigin);
        expect(accepted.body).not.toContain(sandboxOrigin);
        expect(rejected.statusCode).toBe(404);
        expect(rejected.headers['cache-control']).toBe('no-store');
    });

    it.each(['/mcp-app-sandbox/host', '/mcp-app-sandbox/host.js'])(
        'does not expose %s through a wildcard CORS preflight', async (url) => {
        app = await createApp();

        const response = await app.inject({
            method: 'OPTIONS',
            url,
            headers: {
                host: 'sandbox.paws.example',
                origin: 'https://attacker.example',
                'access-control-request-method': 'GET',
            },
        });

        expect(response.statusCode).toBe(404);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it.each([
        ['GET', '/mcp-app-sandbox'],
        ['GET', '/mcp-app-sandbox/'],
        ['GET', '/mcp-app-sandbox/unknown?parentOrigin=https%3A%2F%2Fsecret.example&csp=secret-csp'],
        ['POST', '/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fsecret.example&csp=secret-csp'],
        ['PUT', '/mcp-app-sandbox/host.js?internal=secret.example'],
        ['HEAD', '/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fsecret.example&csp=secret-csp'],
        ['OPTIONS', '/mcp-app-sandbox/unknown?internal=secret.example'],
    ])('protects namespace request %s %s with the static no-store 404', async (method, url) => {
        app = await createApp();

        const response = await app.inject({
            method: method as 'GET',
            url,
            headers: {
                host: 'sandbox.paws.example',
                origin: 'https://attacker.example',
                'access-control-request-method': 'GET',
            },
        });

        expect(response.statusCode).toBe(404);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
        expect(response.json()).toEqual({ error: 'Not found' });
        expect(response.body).not.toContain('secret');
    });

    it('makes an invalid exact route and unknown namespace route indistinguishable', async () => {
        app = await createApp();
        const exact = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fsecret.example&csp=bad',
            headers: { host: 'sandbox.paws.example', origin: 'https://attacker.example' },
        });
        const unknown = await app.inject({
            method: 'GET',
            url: '/mcp-app-sandbox/unknown?parentOrigin=https%3A%2F%2Fsecret.example&csp=bad',
            headers: { host: 'sandbox.paws.example', origin: 'https://attacker.example' },
        });

        expect({
            statusCode: unknown.statusCode,
            body: unknown.body,
            cacheControl: unknown.headers['cache-control'],
            contentType: unknown.headers['content-type'],
            cors: Object.keys(unknown.headers).filter((name) => name.startsWith('access-control-')),
        }).toEqual({
            statusCode: exact.statusCode,
            body: exact.body,
            cacheControl: exact.headers['cache-control'],
            contentType: exact.headers['content-type'],
            cors: Object.keys(exact.headers).filter((name) => name.startsWith('access-control-')),
        });
    });

    it('keeps valid, invalid, wrong-method, and unknown sandbox metadata out of request logs', async () => {
        const logChunks: string[] = [];
        const loggerInstance = pino({ level: 'trace' }, {
            write(chunk: string) { logChunks.push(chunk); },
        });
        const csp = encodeSandboxCspMetadata({
            connectDomains: ['https://api.internal.example'],
            resourceDomains: [],
            frameDomains: [],
        }, false)!;
        app = await createApp({}, loggerInstance);

        await app.inject({
            method: 'GET',
            url: buildHostUrl(csp),
            headers: { host: 'sandbox.paws.example' },
        });
        await app.inject({
            method: 'GET',
            url: `/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fparent-secret.example&csp=${csp}`,
            headers: { host: 'sandbox.paws.example' },
        });
        await app.inject({
            method: 'POST',
            url: `/mcp-app-sandbox/host?parentOrigin=https%3A%2F%2Fparent-secret.example&csp=${csp}`,
            headers: { host: 'sandbox.paws.example' },
        });
        await app.inject({
            method: 'GET',
            url: `/mcp-app-sandbox/unknown?parentOrigin=https%3A%2F%2Fparent-secret.example&csp=${csp}`,
            headers: { host: 'sandbox.paws.example' },
        });

        const logs = logChunks.join('');
        expect(logs).not.toContain('parent-secret.example');
        expect(logs).not.toContain('api.internal.example');
        expect(logs).not.toContain(csp);
        expect(logs).not.toContain('/mcp-app-sandbox/host?');
        expect(logs).not.toContain('/mcp-app-sandbox/unknown?');
    });
});
