import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { createPublicProxy, isPublicIPv4, publicTarget } from './public-proxy.mjs';

test('denies private, host, metadata, reserved and IPv6 destinations', async () => {
    for (const address of ['0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1',
        '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.65.254',
        '192.0.2.1', '198.19.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
        '255.255.255.255', '::1', '::ffff:8.8.8.8', '2606:4700::1111']) assert.equal(isPublicIPv4(address), false, address);
    for (const address of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1']) assert.equal(isPublicIPv4(address), true);
    for (const input of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
        'http://[::1]/', 'http://user:pass@8.8.8.8/', 'http://8.8.8.8:2375/',
        'https://8.8.8.8/', '/relative']) await assert.rejects(publicTarget(input));
});

test('resolves once, checks every answer and pins a public address', async () => {
    let calls = 0;
    const target = await publicTarget('http://example.test/path?q=1', async (host, options) => {
        calls++; assert.equal(host, 'example.test'); assert.deepEqual(options, { all: true, family: 4 });
        return [{ address: '8.8.8.8' }, { address: '1.1.1.1' }];
    });
    assert.equal(calls, 1); assert.equal(target.address, '8.8.8.8');
    await assert.rejects(publicTarget('http://mixed.test/', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]));
    await assert.rejects(publicTarget('http://empty.test/', async () => []));
    await assert.rejects(publicTarget('http://broken.test/', async () => { throw new Error('DNS down'); }));
    for (const input of ['127.0.0.1:443', '[::1]:443', '8.8.8.8:22', '8.8.8.8:443/path', 'user@8.8.8.8:443']) {
        await assert.rejects(publicTarget(input, undefined, true));
    }
});

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers, agent: false }, res => {
            let body = ''; res.on('data', part => body += part); res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

test('HTTP forwards only the checked address, removes proxy secrets, and denies before connect', async () => {
    const upstream = http.createServer((req, res) => {
        assert.equal(req.headers.host, 'public.test');
        assert.equal(req.headers['proxy-authorization'], undefined);
        assert.equal(req.headers['x-hop-secret'], undefined);
        res.end('public-response');
    });
    const upstreamPort = await listen(upstream);
    let outbound = 0;
    const proxy = createPublicProxy({ lookup: async host => [{ address: host === 'public.test' ? '8.8.8.8' : '10.0.0.1' }],
        request: (options, callback) => {
            outbound++; assert.equal(options.hostname, '8.8.8.8'); assert.equal(options.family, 4);
            return http.request({ ...options, hostname: '127.0.0.1', port: upstreamPort }, callback);
        } });
    const port = await listen(proxy);
    try {
        assert.deepEqual(await get(port, 'http://public.test/', { 'proxy-authorization': 'secret',
            connection: 'x-hop-secret', 'x-hop-secret': 'secret' }), { status: 200, body: 'public-response' });
        assert.equal((await get(port, 'http://host.docker.internal/')).status, 403);
        assert.equal((await get(port, 'http://169.254.169.254/')).status, 403);
        assert.equal(outbound, 1);
    } finally { await close(proxy); await close(upstream); }
});

test('CONNECT pins the checked public IP and cannot tunnel to private services', async () => {
    let outbound = 0;
    const echo = net.createServer(socket => socket.pipe(socket));
    const echoPort = await listen(echo);
    const proxy = createPublicProxy({ lookup: async () => [{ address: '8.8.8.8' }], connect: options => {
        outbound++; assert.deepEqual(options, { host: '8.8.8.8', family: 4, port: 443 });
        return net.connect({ host: '127.0.0.1', port: echoPort });
    } });
    const port = await listen(proxy);
    async function tunnel(authority, marker = '') {
        const socket = net.connect({ host: '127.0.0.1', port });
        await once(socket, 'connect');
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${marker}`);
        let data = '';
        try {
            await new Promise((resolve, reject) => {
                socket.setTimeout(2000, () => reject(new Error('Tunnel timed out')));
                socket.on('data', part => { data += part; if (data.includes('403') || (data.includes('200 Connection') && data.endsWith(marker))) resolve(); });
                socket.on('error', reject);
            });
            return data;
        } finally { socket.destroy(); }
    }
    try {
        assert.match(await tunnel('public.test:443', 'echo-marker'), /200 Connection Established[\s\S]*echo-marker$/);
        assert.match(await tunnel('127.0.0.1:443'), /403/);
        assert.match(await tunnel('169.254.169.254:80'), /403/);
        assert.equal(outbound, 1);
    } finally { await close(proxy); await close(echo); }
});
