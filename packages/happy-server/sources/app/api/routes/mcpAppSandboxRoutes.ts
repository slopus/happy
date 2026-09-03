import type { Fastify } from '@/app/api/types';
import {
    parseSandboxCspMetadata,
    parseSandboxOriginList,
    resolveSandboxRequest,
    type SandboxCspMetadata,
} from '@/app/api/mcpAppSandboxSecurity';
import {
    MCP_APP_SANDBOX_HOST_HTML,
    MCP_APP_SANDBOX_HOST_JAVASCRIPT,
} from '@/app/api/generated/mcpAppHostShellAssets';
import {
    mcpAppSandboxNotFound,
    removeMcpAppSandboxCorsHeaders,
} from '@/app/api/mcpAppSandboxHttp';

export interface McpAppSandboxRouteOptions {
    sandboxOrigin: string | undefined;
    allowedParentOrigins: readonly string[];
    development: boolean;
}

function environmentOptions(): McpAppSandboxRouteOptions {
    const development = process.env.NODE_ENV === 'development';
    return {
        sandboxOrigin: process.env.HAPPY_MCP_APP_SANDBOX_ORIGIN,
        allowedParentOrigins: parseSandboxOriginList(
            process.env.HAPPY_MCP_APP_PARENT_ORIGINS,
            development,
        ) ?? [],
        development,
    };
}

function origins(values: readonly string[]): string {
    return values.length > 0 ? ` ${values.join(' ')}` : '';
}

export function buildMcpAppSandboxCsp(
    parentOrigin: string,
    metadata: SandboxCspMetadata,
): string {
    return [
        "default-src 'none'",
        `script-src 'self' 'unsafe-inline'${origins(metadata.resourceDomains)}`,
        `style-src 'unsafe-inline'${origins(metadata.resourceDomains)}`,
        `img-src data: blob:${origins(metadata.resourceDomains)}`,
        `media-src blob:${origins(metadata.resourceDomains)}`,
        `font-src data:${origins(metadata.resourceDomains)}`,
        metadata.connectDomains.length > 0
            ? `connect-src ${metadata.connectDomains.join(' ')}`
            : "connect-src 'none'",
        `frame-src 'self'${origins(metadata.frameDomains)}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${parentOrigin}`,
    ].join('; ');
}

export function mcpAppSandboxRoutes(
    app: Fastify,
    options: McpAppSandboxRouteOptions = environmentOptions(),
): void {
    const routeConfig = { cors: false };
    const silentRoute = { config: routeConfig, logLevel: 'silent' as const };

    app.options('/mcp-app-sandbox/host', silentRoute, async (_request, reply) => mcpAppSandboxNotFound(reply));
    app.options('/mcp-app-sandbox/host.js', silentRoute, async (_request, reply) => mcpAppSandboxNotFound(reply));

    app.get('/mcp-app-sandbox/host', { ...silentRoute, exposeHeadRoute: false }, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const parentOrigin = typeof query.parentOrigin === 'string' ? query.parentOrigin : undefined;
        const csp = typeof query.csp === 'string' ? query.csp : undefined;
        const resolved = resolveSandboxRequest({
            requestHost: request.headers.host,
            parentOrigin,
            sandboxOrigin: options.sandboxOrigin,
            allowedParentOrigins: options.allowedParentOrigins,
            development: options.development,
        });
        const metadata = parseSandboxCspMetadata(csp, options.development);
        if (!resolved.ok || !metadata) return mcpAppSandboxNotFound(reply);

        removeMcpAppSandboxCorsHeaders(reply);
        return reply.headers({
            'Cache-Control': 'no-store',
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': buildMcpAppSandboxCsp(resolved.parentOrigin, metadata),
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-write=()',
            'Cross-Origin-Resource-Policy': 'cross-origin',
        }).send(MCP_APP_SANDBOX_HOST_HTML);
    });

    app.get('/mcp-app-sandbox/host.js', { ...silentRoute, exposeHeadRoute: false }, async (request, reply) => {
        const firstConfiguredParent = options.allowedParentOrigins[0];
        const resolved = resolveSandboxRequest({
            requestHost: request.headers.host,
            parentOrigin: firstConfiguredParent,
            sandboxOrigin: options.sandboxOrigin,
            allowedParentOrigins: options.allowedParentOrigins,
            development: options.development,
        });
        if (!resolved.ok) return mcpAppSandboxNotFound(reply);

        removeMcpAppSandboxCorsHeaders(reply);
        return reply.headers({
            'Cache-Control': 'no-store',
            'Content-Type': 'text/javascript; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin',
        }).send(MCP_APP_SANDBOX_HOST_JAVASCRIPT);
    });

    app.all('/mcp-app-sandbox', silentRoute, async (_request, reply) => mcpAppSandboxNotFound(reply));
    app.all('/mcp-app-sandbox/*', silentRoute, async (_request, reply) => mcpAppSandboxNotFound(reply));
}
