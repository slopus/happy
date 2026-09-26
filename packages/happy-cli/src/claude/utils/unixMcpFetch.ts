/** HTTP-over-Unix fetch for the mandatory stdio MCP bridge; no TCP relay. */
import { request } from 'node:http';
import { Readable } from 'node:stream';

export function unixMcpFetch(socketPath: string, token: string): typeof fetch {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin !== 'http://localhost' || !token) throw new Error('Invalid Unix MCP request');
        return new Promise<Response>((resolve, reject) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${token}`);
            const req = request({ socketPath, path: url.pathname + url.search, method: init?.method ?? 'GET', headers: Object.fromEntries(headers.entries()), signal: init?.signal ?? undefined }, res => {
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
                const status = res.statusCode ?? 500;
                resolve(new Response([204, 205, 304].includes(status) ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
            });
            req.on('error', reject);
            if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') { req.destroy(); reject(new Error('Unsupported MCP body')); return; }
            req.end(init?.body);
        });
    };
}
