import type { FastifyReply } from 'fastify';

const NO_STORE_NOT_FOUND = { error: 'Not found' } as const;

export function isLiteralMcpAppSandboxRequestUrl(rawUrl: string | undefined): boolean {
    if (!rawUrl) return false;
    return rawUrl === '/mcp-app-sandbox'
        || rawUrl.startsWith('/mcp-app-sandbox?')
        || rawUrl.startsWith('/mcp-app-sandbox/');
}

export function removeMcpAppSandboxCorsHeaders(reply: FastifyReply): void {
    for (const name of Object.keys(reply.getHeaders())) {
        const lower = name.toLowerCase();
        if (lower.startsWith('access-control-allow-')
            || lower === 'access-control-expose-headers'
            || lower === 'access-control-max-age') {
            reply.removeHeader(name);
        }
    }
}

export function mcpAppSandboxNotFound(reply: FastifyReply) {
    removeMcpAppSandboxCorsHeaders(reply);
    return reply
        .header('Cache-Control', 'no-store')
        .code(404)
        .send(NO_STORE_NOT_FOUND);
}
