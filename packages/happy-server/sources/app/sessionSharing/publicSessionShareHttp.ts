import type { FastifyReply } from 'fastify';

export function isPublicSessionShareApiUrl(url: string): boolean {
    const pathname = url.split('?', 1)[0];
    return pathname === '/v1/public/session-shares' || pathname.startsWith('/v1/public/session-shares/');
}

export function setPublicSessionShareHeaders(reply: FastifyReply): void {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    reply.header('X-Content-Type-Options', 'nosniff');
}

export function publicSessionShareNotFound(reply: FastifyReply) {
    setPublicSessionShareHeaders(reply);
    return reply.code(404).send({ error: 'Shared session not found' });
}
