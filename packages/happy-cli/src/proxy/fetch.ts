/**
 * Proxy aware global `fetch`.
 *
 * Node's global fetch is undici, which only honours proxy environment variables
 * when the process was started with NODE_USE_ENV_PROXY=1 / --use-env-proxy, and
 * cannot express system, PAC or manual proxy configuration at all. When Happy
 * configures a proxy, this implementation performs the HTTP(S) request with a
 * Node agent so that fetch based callers (Happy's own OAuth flows, the MCP HTTP
 * transports and vendor SDKs) are proxied exactly like axios and socket.io.
 *
 * Requests with no resolved agent are handed back to the original fetch, so the
 * default, direct path keeps stock Node behaviour.
 */
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import type { Agent } from 'node:http';

export type ProxyAgentResolver = (url: string) => Agent | undefined | Promise<Agent | undefined>;

/** Node's fetch argument types, without pulling in the DOM lib. */
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const MAX_REDIRECTS = 20;

let originalFetch: typeof globalThis.fetch | undefined;
let agentResolver: ProxyAgentResolver | undefined;

function canProxyFetch(): boolean {
    return typeof globalThis.fetch === 'function'
        && typeof globalThis.Request === 'function'
        && typeof globalThis.Response === 'function';
}

function requestHeaders(request: Request): Record<string, string> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
        headers[key] = value;
    });
    return headers;
}

function toResponseHeaders(response: IncomingHttpHeaders, rawHeaders: readonly string[]): Headers {
    const headers = new Headers();
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        headers.append(rawHeaders[index], rawHeaders[index + 1]);
    }
    if (rawHeaders.length === 0) {
        for (const [key, value] of Object.entries(response)) {
            if (typeof value === 'string') {
                headers.append(key, value);
            } else if (Array.isArray(value)) {
                for (const entry of value) {
                    headers.append(key, entry);
                }
            }
        }
    }
    return headers;
}

function decodeBody(stream: Readable, encoding: string | undefined): Readable {
    switch ((encoding ?? '').toLowerCase()) {
        case 'gzip':
        case 'x-gzip':
        case 'deflate':
            return stream.pipe(createUnzip());
        case 'br':
            return stream.pipe(createBrotliDecompress());
        default:
            return stream;
    }
}

interface PerformResult {
    response: Response;
    location?: string;
}

function performRequest(
    target: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    agent: Agent | undefined,
    signal: AbortSignal,
): Promise<PerformResult> {
    return new Promise((resolve, reject) => {
        const options: RequestOptions = {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            path: `${target.pathname}${target.search}`,
            method,
            headers,
            agent,
            signal,
        };
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const request = send(options, (response) => {
            const status = response.statusCode ?? 0;
            const rawHeaders = response.rawHeaders ?? [];
            const responseHeaders = toResponseHeaders(response.headers, rawHeaders);
            const location = response.headers.location;
            const bodyless = method === 'HEAD' || status === 204 || status === 304;
            const stream = bodyless ? Readable.from([]) : decodeBody(response, response.headers['content-encoding']);
            if (response.headers['content-encoding']) {
                responseHeaders.delete('content-encoding');
            }
            const result = new Response(Readable.toWeb(stream) as ReadableStream, {
                status,
                statusText: response.statusMessage ?? '',
                headers: responseHeaders,
            });
            resolve({ response: result, location });
        });

        request.on('error', reject);
        if (body && method !== 'GET' && method !== 'HEAD') {
            request.end(body);
        } else {
            request.end();
        }
    });
}

async function proxyFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const resolver = agentResolver;
    if (!resolver || !canProxyFetch() || !originalFetch) {
        return originalFetch!(input, init);
    }

    let request: Request;
    try {
        request = new Request(input, init);
    } catch (error) {
        // Invalid input: let the platform decide how to report it.
        return originalFetch(input, init);
    }

    const agent = await resolver(request.url);
    if (!agent) {
        return originalFetch(input, init);
    }

    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
    const headers = requestHeaders(request);
    if (body) {
        headers['content-length'] = String(body.byteLength);
    }

    let currentUrl = new URL(request.url);
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = headers;
    let redirects = 0;

    for (;;) {
        let result: PerformResult;
        try {
            result = await performRequest(currentUrl, currentMethod, currentHeaders, currentBody, agent, request.signal);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw error;
            }
            throw new TypeError(`fetch failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }

        const { response, location } = result;
        const isRedirect = response.status >= 300 && response.status < 400 && location !== undefined;
        if (!isRedirect) {
            Object.defineProperty(response, 'url', { value: currentUrl.href, configurable: true });
            Object.defineProperty(response, 'redirected', { value: redirects > 0, configurable: true });
            return response;
        }
        if (request.redirect === 'manual') {
            return response;
        }
        if (request.redirect === 'error') {
            throw new TypeError(`fetch failed: redirect mode is set to error (${response.status})`);
        }
        if (++redirects > MAX_REDIRECTS) {
            throw new TypeError('fetch failed: maximum redirect count exceeded');
        }
        await response.body?.cancel();

        const nextUrl = new URL(location, currentUrl);
        const dropsBody = response.status === 303
            || ((response.status === 301 || response.status === 302) && currentMethod === 'POST');
        currentUrl = nextUrl;
        if (dropsBody) {
            currentMethod = 'GET';
            currentBody = undefined;
            currentHeaders = { ...currentHeaders };
            delete currentHeaders['content-length'];
            delete currentHeaders['content-type'];
        }
    }
}

/**
 * Replaces the global fetch with the proxy aware implementation. Requests with
 * no proxy keep using the original fetch.
 */
export function installProxiedFetch(resolver: ProxyAgentResolver): void {
    if (!canProxyFetch()) {
        return;
    }
    agentResolver = resolver;
    if (originalFetch) {
        return;
    }
    originalFetch = globalThis.fetch;
    globalThis.fetch = proxyFetch as typeof globalThis.fetch;
}

/** Restores the original fetch, used by tests. */
export function uninstallProxiedFetch(): void {
    if (originalFetch) {
        globalThis.fetch = originalFetch;
        originalFetch = undefined;
    }
    agentResolver = undefined;
}
