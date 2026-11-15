import http from 'node:http';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

// Only globally routable IPv4 destinations. IPv6 is deliberately unavailable
// until an equivalent policy and Docker topology have been verified for it.
const blocked = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const number = ip => ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
export function isPublicIPv4(ip) {
    if (net.isIP(ip) !== 4) return false;
    const value = number(ip);
    return !blocked.some(([base, bits]) => (value >>> (32 - bits)) === (number(base) >>> (32 - bits)));
}

export async function publicTarget(input, lookup = dnsLookup, tunnel = false) {
    if (tunnel && !/^[a-zA-Z0-9.-]+:\d+$/.test(input)) throw new Error('Forbidden target');
    const url = new URL(tunnel ? `http://${input}` : input);
    const port = Number(url.port || 80);
    if (url.protocol !== 'http:' || url.username || url.password || url.hash
        || ![80, 443].includes(port) || (!tunnel && port !== 80)
        || (tunnel && (url.pathname !== '/' || url.search))) throw new Error('Forbidden target');
    const answers = net.isIP(url.hostname)
        ? [{ address: url.hostname }]
        : await lookup(url.hostname, { all: true, family: 4 });
    if (!answers.length || answers.some(answer => !isPublicIPv4(answer.address))) throw new Error('Forbidden target');
    // Pin the checked address. Neither http.request nor net.connect may resolve
    // the untrusted hostname a second time (including after a DNS rebinding).
    return { address: answers[0].address, port, url };
}

function cleanHeaders(headers) {
    const connectionFields = String(headers.connection ?? '').toLowerCase().split(',').map(v => v.trim());
    const omit = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
        'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', ...connectionFields]);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !omit.has(name)));
}

export function createPublicProxy({ lookup = dnsLookup, connect = net.connect, request = http.request } = {}) {
    const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
        let target;
        try { target = await publicTarget(req.url, lookup); }
        catch { req.resume(); res.writeHead(403).end('Destination denied'); return; }
        if (req.destroyed) return;
        const upstream = request({ hostname: target.address, family: 4, port: target.port,
            path: target.url.pathname + target.url.search, method: req.method,
            headers: { ...cleanHeaders(req.headers), host: target.url.host, connection: 'close' },
            agent: false }, response => {
            res.writeHead(response.statusCode ?? 502, cleanHeaders(response.headers));
            response.on('error', () => res.destroy());
            response.pipe(res);
        });
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(502).end('Upstream unavailable');
            else res.destroy();
        });
        upstream.setTimeout(30_000, () => upstream.destroy());
        req.on('aborted', () => upstream.destroy());
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
    });
    server.on('connect', async (req, client, head) => {
        client.on('error', () => client.destroy());
        let target;
        try { target = await publicTarget(req.url, lookup, true); }
        catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        if (client.destroyed) return;
        const upstream = connect({ host: target.address, family: 4, port: target.port });
        let connected = false;
        upstream.setTimeout(30_000, () => upstream.destroy());
        upstream.on('connect', () => {
            connected = true;
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            client.pipe(upstream).pipe(client);
        });
        upstream.on('error', () => {
            if (!connected && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            else client.destroy();
        });
        upstream.on('close', () => client.destroy());
        client.on('close', () => upstream.destroy());
    });
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.maxConnections = 256;
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = createPublicProxy();
    server.listen(3128, '0.0.0.0', () => console.log('Public-only HTTP/CONNECT proxy listening on 3128'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
}
