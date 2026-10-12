/**
 * A minimal HTTP proxy used by the proxy tests.
 *
 * It supports the three things Happy needs: CONNECT tunnels (https/wss),
 * absolute-form HTTP requests (http through an HTTP proxy) and WebSocket
 * upgrades, and records every request so tests can assert that traffic really
 * went through the proxy instead of direct.
 */
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';

export interface RecordedProxyRequest {
    kind: 'connect' | 'http' | 'upgrade';
    target: string;
    method: string;
}

export interface TestProxy {
    url: string;
    requests: RecordedProxyRequest[];
    close(): Promise<void>;
}

function forwardUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/');
    const upstream = net.connect(Number(url.port || 80), url.hostname, () => {
        const headers = Object.entries(request.headers)
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
            .join('\r\n');
        upstream.write(`${request.method ?? 'GET'} ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length > 0) {
            upstream.write(head);
        }
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => {});
}

/** Starts a throw-away HTTP proxy on a random port. */
export async function startTestProxy(host = '127.0.0.1'): Promise<TestProxy> {
    const requests: RecordedProxyRequest[] = [];

    const server = http.createServer((request, response) => {
        const target = request.url ?? '';
        requests.push({ kind: 'http', target, method: request.method ?? 'GET' });
        if (!/^https?:\/\//i.test(target)) {
            response.writeHead(400).end('absolute-form requests only');
            return;
        }
        const url = new URL(target);
        const upstream = http.request(
            {
                hostname: url.hostname,
                port: url.port || 80,
                path: `${url.pathname}${url.search}`,
                method: request.method,
                headers: { ...request.headers, host: url.host },
            },
            (upstreamResponse) => {
                response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
                upstreamResponse.pipe(response);
            },
        );
        upstream.on('error', () => response.destroy());
        request.pipe(upstream);
    });

    server.on('connect', (request, socket, head) => {
        requests.push({ kind: 'connect', target: request.url ?? '', method: 'CONNECT' });
        const [host, port] = (request.url ?? '').split(':');
        const upstream = net.connect(Number(port || 443), host, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) {
                upstream.write(head);
            }
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => {});
    });

    server.on('upgrade', (request, socket, head) => {
        requests.push({ kind: 'upgrade', target: request.url ?? '', method: request.method ?? 'GET' });
        forwardUpgrade(request, socket, head);
    });

    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const address = server.address() as AddressInfo;

    return {
        url: `http://${host}:${address.port}`,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/** Starts a throw-away HTTP server that answers JSON and echoes the request. */
export async function startTargetServer(host = '127.0.0.1'): Promise<{ url: string; close(): Promise<void> }> {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, path: request.url, method: request.method }));
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const address = server.address() as AddressInfo;
    return {
        url: `http://${host}:${address.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/**
 * Returns a non-loopback local IPv4 address, or undefined when the machine has
 * none. The proxy end-to-end tests need it, because loopback destinations are
 * always used directly by design.
 */
export function localExternalAddress(): string | undefined {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) {
                return address.address;
            }
        }
    }
    return undefined;
}

/** Splits a `host:port` proxy URL into its parts. */
export function proxyParts(proxyUrl: string): { host: string; port: number } {
    const url = new URL(proxyUrl);
    return { host: url.hostname, port: Number(url.port) };
}
