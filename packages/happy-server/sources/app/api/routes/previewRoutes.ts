/**
 * Remote preview relay routes.
 *
 * Flow:
 *   Browser iframe
 *     ─GET/POST→ /v1/preview/:machineId/:port/*?ptoken=…
 *       (this route)
 *     ─rpc-request→ daemon socket (emitWithAck 'proxy-http')
 *       (daemon relays to 127.0.0.1:{port})
 *     ← ProxyResponse ({ type: 'success'|'error', … })
 *   Response body (+rewriteHtml for text/html) → browser
 *
 * Authentication is intentionally split:
 * - `POST /v1/preview-token` uses the normal Bearer auth + DB check to mint a
 *   short-lived HMAC token bound to (userId, machineId, port).
 * - The preview route itself accepts only the ptoken (iframe src cannot carry
 *   an Authorization header).
 */

import { Socket } from "socket.io";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { eventRouter } from "@/app/events/eventRouter";
import { signPreviewToken, verifyPreviewToken } from "@/modules/preview/previewToken";
import { readPreviewCookie, buildPreviewCookie } from "@/modules/preview/previewCookie";
import { rewriteHtml, rewriteJsCss } from "@/modules/preview/rewriteHtml";
import { rewriteLinkHeader } from "@/modules/preview/rewriteLinkHeader";
import { rewriteLocationHeader } from "@/modules/preview/rewriteLocationHeader";
import { renderExpiredPtokenHtml, shouldServeExpiredHtml } from "@/modules/preview/expiredPtokenHtml";
import { parsePreviewHost } from "@/modules/preview/parsePreviewHost";
import { type Fastify } from "../types";

interface ProxySuccess {
    type: 'success';
    status: number;
    headers: Record<string, string>;
    bodyB64: string;
    truncated: boolean;
}

interface ProxyError {
    type: 'error';
    code: string;
    message: string;
}

type ProxyRpcResponse = ProxySuccess | ProxyError;

const RPC_TIMEOUT_MS = 35_000;

const ALL_METHODS: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'> =
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface ProxyHttpRequestPayload {
    port: number;
    method: string;
    path: string;
    headers: Record<string, string>;
    bodyB64: string | null;
}

function isProxyRpcResponse(raw: unknown): raw is ProxyRpcResponse {
    if (!raw || typeof raw !== 'object') return false;
    const candidate = raw as Partial<ProxyRpcResponse>;
    return candidate.type === 'success' || candidate.type === 'error';
}

function findMachineSockets(userId: string, machineId: string): Socket[] {
    const connections = eventRouter.getConnections(userId);
    if (!connections) return [];
    const sockets: Socket[] = [];
    for (const c of connections) {
        if (c.connectionType === 'machine-scoped' && c.machineId === machineId) {
            if (c.socket.connected) sockets.push(c.socket);
        }
    }
    return sockets;
}

export async function relayProxyHttpRequest(
    machineSockets: Array<Pick<Socket, 'id' | 'timeout'>>,
    payload: ProxyHttpRequestPayload,
    timeoutMs = RPC_TIMEOUT_MS,
): Promise<ProxyRpcResponse> {
    const attempts = machineSockets.map(async (socket) => {
        const raw = await socket
            .timeout(timeoutMs)
            .emitWithAck('proxy-http-request', payload);
        if (!isProxyRpcResponse(raw)) {
            throw new Error(`Malformed proxy response from socket ${socket.id}`);
        }
        return raw;
    });
    return Promise.any(attempts);
}

function filterForwardedHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        // Strip hop-by-hop + things only meaningful to happy-server itself.
        if (
            lower === 'host' ||
            lower === 'connection' ||
            lower === 'keep-alive' ||
            lower === 'upgrade' ||
            lower === 'proxy-authenticate' ||
            lower === 'proxy-authorization' ||
            lower === 'te' ||
            lower === 'trailer' ||
            lower === 'transfer-encoding' ||
            lower === 'authorization' ||
            lower === 'cookie'
        ) continue;
        out[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
}

export function stripResponseHeaders(
    headers: Record<string, string>,
    prefix?: string,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        // Drop headers that don't survive rewriting (Content-Length changes)
        // and frame-ancestor directives that would block iframe embedding.
        if (lower === 'content-length' || lower === 'content-encoding') continue;
        if (lower === 'x-frame-options') continue;
        // For the `Link` header, parse and selectively rewrite: drop
        // `rel=preload` entries (they leak as early-hint preloads against
        // location.origin = the relay host and the HTML body already carries
        // equivalent <link rel="preload"> tags that get prefixed by the
        // rewriter), and rewrite absolute-path URLs in surviving entries
        // (e.g. rel=canonical / rel=manifest) so they route through the
        // proxy. When no entries survive, drop the header entirely.
        // See specs/preview-nextjs-turbopack-hydration/ Phase 3.
        if (lower === 'link') {
            if (!prefix) continue; // Backwards compat: drop when no prefix supplied.
            const rewritten = rewriteLinkHeader(value, prefix);
            if (rewritten === null) continue;
            out[key] = rewritten;
            continue;
        }
        // `Location` (3xx redirects): dev server emits absolute paths
        // (e.g. Next.js `redirect('/admin')`) that the browser would
        // follow against the relay origin → escape to relay host root.
        // Prefix the path so the redirect stays inside the preview mount.
        // See specs/preview-relay-escape-plug/ Phase A.
        if (lower === 'location') {
            out[key] = rewriteLocationHeader(value, prefix ?? '');
            continue;
        }
        out[key] = value;
    }
    return out;
}

function deleteHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === target) delete headers[key];
    }
}

function appendVaryOrigin(headers: Record<string, string>): void {
    const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'vary');
    if (!existingKey) {
        headers['Vary'] = 'Origin';
        return;
    }
    const existing = headers[existingKey];
    const parts = existing.split(',').map((part) => part.trim().toLowerCase());
    if (!parts.includes('origin')) {
        headers[existingKey] = `${existing}, Origin`;
    }
}

export function applySubdomainPreviewCorsHeaders(
    headers: Record<string, string>,
    requestOrigin: string | undefined,
    requestHost: string | undefined,
    requestedHeaders?: string,
): Record<string, string> {
    if (!requestOrigin) return headers;
    let originHost: string;
    try {
        originHost = new URL(requestOrigin).host;
    } catch {
        return headers;
    }
    const originPreview = parsePreviewHost(originHost);
    const targetPreview = parsePreviewHost(requestHost);
    if (!originPreview || !targetPreview) return headers;
    if (originPreview.machineId !== targetPreview.machineId) return headers;

    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Origin');
    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Credentials');
    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Methods');
    deleteHeaderCaseInsensitive(headers, 'Access-Control-Allow-Headers');

    headers['Access-Control-Allow-Origin'] = requestOrigin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = ALL_METHODS.join(', ');
    headers['Access-Control-Allow-Headers'] = requestedHeaders || 'Content-Type, Authorization';
    appendVaryOrigin(headers);
    return headers;
}

export function previewRoutes(app: Fastify) {
    // Mint a short-lived ptoken that binds (userId, machineId, port) under HMAC.
    app.post('/v1/preview-token', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                machineId: z.string().min(1),
                port: z.number().int().min(1).max(65535),
            }),
            response: {
                200: z.object({
                    token: z.string(),
                    expiresAt: z.number(),
                }),
                403: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { machineId, port } = request.body;

        const machine = await db.machine.findFirst({ where: { id: machineId, accountId: userId } });
        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        const signed = signPreviewToken({ userId, machineId, port });
        log({ module: 'preview', userId, machineId, port }, 'Minted preview token');
        return reply.send({ token: signed.token, expiresAt: signed.expiresAt });
    });

    // Preview relay route lives inside its own encapsulation scope so we can
    // register a raw-buffer content-type parser without affecting other JSON
    // routes on the same app.
    app.register(async (scope) => {
        // Strip inherited built-in parsers (json, urlencoded, etc.) within
        // this scope. addContentTypeParser('*', …) is a *fallback*, not an
        // override — without this, JSON POST bodies are parsed into objects
        // upstream and request.body.length is undefined, so the relay
        // forwards the request with Content-Length set but no body, and the
        // dev server hangs waiting for bytes that never arrive.
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
            done(null, body);
        });

        scope.route({
            method: ALL_METHODS,
            url: '/v1/preview/:machineId/:port/*',
            handler: async (request, reply) => {
                const params = request.params as { machineId: string; port: string; '*'?: string };
                const query = request.query as { ptoken?: string };
                // specs/preview-iframe-origin-isolation-subdomain — when the
                // iframe Host matches `<mid>-<port>.preview.<zone>`,
                // api.ts:rewriteUrl rewrote the URL into this canonical
                // path-prefix shape. We re-parse the Host here to know we
                // came from the subdomain origin (vs an actual path-prefix
                // request to the studio host) so we can disable URL prefix
                // rewriting and emit host-only cookies.
                const previewMode = parsePreviewHost(request.headers.host as string | undefined)
                    ? 'subdomain' as const
                    : 'path-prefix' as const;

                const portNum = Number.parseInt(params.port, 10);
                if (!Number.isInteger(portNum)) {
                    return reply.code(400).send({ error: 'Invalid port' });
                }

                // Phase 9: accept the token from either `?ptoken=` (initial
                // iframe load) or the per-preview cookie (every subsequent
                // subresource once the first response set it). Query wins
                // when both are present — that's the web-ui's refresh path.
                const cookieToken = readPreviewCookie(
                    request.headers.cookie as string | undefined,
                    params.machineId,
                    portNum,
                );
                // specs/remote-preview-relay Phase 10c — when a browser top-
                // level navigation lands on an expired/missing-ptoken URL,
                // respond with a small HTML page whose inline JS re-mints
                // via /api/preview-mint-remote (Phase 10b) and reloads.
                // Non-HTML callers (JSON clients, curl, image subresources)
                // keep getting the existing JSON 401.
                const acceptHeader = request.headers.accept as string | undefined;
                const wantsHtmlFallback = shouldServeExpiredHtml(acceptHeader);
                const token = query.ptoken ?? cookieToken;
                if (!token) {
                    if (wantsHtmlFallback) {
                        return reply
                            .code(401)
                            .header('Content-Type', 'text/html; charset=utf-8')
                            .send(renderExpiredPtokenHtml({
                                machineId: params.machineId,
                                port: portNum,
                                reason: 'missing',
                            }));
                    }
                    return reply.code(401).send({ error: 'Missing ptoken' });
                }
                const claims = verifyPreviewToken(token);
                if (!claims) {
                    if (wantsHtmlFallback) {
                        return reply
                            .code(401)
                            .header('Content-Type', 'text/html; charset=utf-8')
                            .send(renderExpiredPtokenHtml({
                                machineId: params.machineId,
                                port: portNum,
                                reason: 'expired-or-invalid',
                            }));
                    }
                    return reply.code(401).send({ error: 'Invalid or expired ptoken' });
                }
                if (claims.machineId !== params.machineId || claims.port !== portNum) {
                    return reply.code(403).send({ error: 'Token does not match requested machine/port' });
                }

                if (
                    request.method === 'OPTIONS' &&
                    typeof request.headers['access-control-request-method'] === 'string'
                ) {
                    const outHeaders = applySubdomainPreviewCorsHeaders(
                        {},
                        request.headers.origin as string | undefined,
                        request.headers.host as string | undefined,
                        request.headers['access-control-request-headers'] as string | undefined,
                    );
                    return reply.code(204).headers(outHeaders).send();
                }

                // Find machine sockets. A daemon reconnect can briefly leave
                // stale machine-scoped connections around; try all live
                // candidates so one stale socket cannot pin preview to a 35s
                // relay timeout while a fresh daemon socket is already ready.
                const machineSockets = findMachineSockets(claims.userId, params.machineId);
                if (machineSockets.length === 0) {
                    return reply.code(502).send({ error: 'Machine offline' });
                }
                if (machineSockets.length > 1) {
                    log({ module: 'preview', level: 'warn' }, `multiple machine sockets for preview relay: user=${claims.userId} machine=${params.machineId} count=${machineSockets.length}`);
                }

                // Build the upstream path (everything after `:port/`) + query string
                // excluding the ptoken we added.
                const subPath = params['*'] ?? '';
                const upstreamQuery = new URLSearchParams();
                for (const [k, v] of Object.entries(request.query as Record<string, string>)) {
                    if (k === 'ptoken') continue;
                    upstreamQuery.append(k, v);
                }
                const qs = upstreamQuery.toString();
                const upstreamPath = `/${subPath}${qs ? `?${qs}` : ''}`;

                const bodyBuf: Buffer | undefined = request.body as Buffer | undefined;
                const bodyB64 = bodyBuf && bodyBuf.length > 0 ? bodyBuf.toString('base64') : null;

                const forwardHeaders = filterForwardedHeaders(request.headers);

                // Relay via the daemon's plain `proxy-http-request` socket event
                // — deliberately outside the encrypted rpc-request pipeline
                // because happy-server has no access to the machine key and
                // needs to read response bodies to rewrite HTML anyway.
                let rpcResponse: ProxyRpcResponse;
                try {
                    rpcResponse = await relayProxyHttpRequest(machineSockets, {
                        port: portNum,
                        method: request.method,
                        path: upstreamPath,
                        headers: forwardHeaders,
                        bodyB64,
                    });
                } catch (err) {
                    log({ module: 'preview', level: 'error' }, `proxy-http-request relay failed for ${machineSockets.length} candidate(s): ${(err as Error).message}`);
                    return reply.code(504).send({ error: 'Upstream relay timeout' });
                }

                if (rpcResponse.type === 'error') {
                    const status =
                        rpcResponse.code === 'INVALID_PORT' || rpcResponse.code === 'INVALID_PATH' ? 400 :
                        rpcResponse.code === 'TIMEOUT' ? 504 : 502;
                    return reply.code(status).send({ code: rpcResponse.code, error: rpcResponse.message });
                }

                // Successful proxy response — rewrite HTML/JS/CSS if applicable.
                // subdomain mode: prefix='' so absolute paths stay on the
                // isolated origin and rewriters become no-ops.
                const prefix = previewMode === 'subdomain'
                    ? ''
                    : `/v1/preview/${params.machineId}/${portNum}`;
                const contentType = (rpcResponse.headers['content-type'] ?? '').toLowerCase();
                let responseBody: Buffer = Buffer.from(rpcResponse.bodyB64, 'base64');

                if (contentType.includes('text/html')) {
                    responseBody = Buffer.from(rewriteHtml(responseBody.toString('utf-8'), prefix), 'utf-8');
                } else if (
                    contentType.includes('javascript') ||
                    contentType.includes('typescript') ||
                    contentType.includes('text/css')
                ) {
                    responseBody = Buffer.from(rewriteJsCss(responseBody.toString('utf-8'), prefix), 'utf-8');
                }

                const outHeaders = stripResponseHeaders(rpcResponse.headers, prefix || undefined);
                if (rpcResponse.truncated) {
                    outHeaders['X-Preview-Truncated'] = '1';
                }
                applySubdomainPreviewCorsHeaders(
                    outHeaders,
                    request.headers.origin as string | undefined,
                    request.headers.host as string | undefined,
                    request.headers['access-control-request-headers'] as string | undefined,
                );
                // Always send fresh Content-Length because the body may have been rewritten.
                outHeaders['Content-Length'] = String(responseBody.length);

                // Phase 9: bake the token into a path-scoped HttpOnly cookie
                // so the iframe's subresource requests authenticate without
                // needing `?ptoken=` in their URLs. Max-Age tracks the signed
                // ptoken's own expiry; the web-ui refreshes the iframe well
                // before expiry (remotePreviewUrl REFRESH_MARGIN_MS = 5min).
                //
                // subdomain mode: Path=/, host-only Domain — cross-preview
                // and studio-vs-preview cookie leakage both blocked.
                // SameSite=None + Secure required for cross-origin iframe
                // subresource requests on HTTPS.
                const maxAgeSeconds = Math.floor(Math.max(0, claims.exp - Date.now()) / 1000);
                const isHttps = (request.headers['x-forwarded-proto'] === 'https') || (request.protocol === 'https');
                outHeaders['Set-Cookie'] = buildPreviewCookie(
                    params.machineId,
                    portNum,
                    token,
                    maxAgeSeconds,
                    previewMode === 'subdomain'
                        ? { mode: 'subdomain', sameSite: isHttps ? 'None' : 'Lax', secure: isHttps }
                        : {},
                );

                reply.raw.writeHead(rpcResponse.status, outHeaders);
                reply.raw.end(responseBody);
            },
        });
    });
}
