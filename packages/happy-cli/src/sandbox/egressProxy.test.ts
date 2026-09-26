import { describe, expect, it, vi } from 'vitest';
import { createConnection, createServer } from 'node:net';
import { createEgressProxy, isPublicAddress, resolveConnectTarget } from './egressProxy';

describe('CONNECT destination policy', () => {
    it.each(['127.0.0.1', '10.1.2.3', '172.31.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.1.2.3', '224.0.0.1', '198.18.0.1', '192.0.2.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '64:ff9b::808:808', '2001:db8::1', '2002:0808:0808::1'])('rejects non-public or translated %s', address => expect(isPublicAddress(address)).toBe(false));
    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public %s', address => expect(isPublicAddress(address)).toBe(true));
    it('resolves once, rejects mixed/private answers, and pins the selected address', async () => {
        const lookup = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        expect(await resolveConnectTarget('api.anthropic.com:443', ['api.anthropic.com'], lookup)).toEqual({ host: '8.8.8.8', port: 443, family: 4 });
        expect(lookup).toHaveBeenCalledTimes(1);
        await expect(resolveConnectTarget('api.anthropic.com:443', ['api.anthropic.com'], lookup)).rejects.toThrow();
        await expect(resolveConnectTarget('api.anthropic.com:443', ['api.anthropic.com'], async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }])).rejects.toThrow();
    });
    it.each(['evil.test:443', 'api.anthropic.com.evil.test:443', 'api.anthropic.com:80', '127.0.0.1:443', 'api.anthropic.com.:443', 'user@api.anthropic.com:443'])('rejects authority %s before DNS', async authority => {
        const lookup = vi.fn();
        await expect(resolveConnectTarget(authority, ['api.anthropic.com'], lookup)).rejects.toThrow();
        expect(lookup).not.toHaveBeenCalled();
    });
    it('rejects raw HTTP and malformed requests on the wire', async () => {
        const server = createEgressProxy();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            for (const line of ['GET http://api.anthropic.com/ HTTP/1.1', 'CONNECT api.anthropic.com:80 HTTP/1.1', 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nContent-Length: 1']) {
                const result = await new Promise<string>((resolve, reject) => {
                    const socket = createConnection({ port: (server.address() as { port: number }).port, host: '127.0.0.1' });
                    let output = '';
                    socket.on('error', reject).on('data', data => { output += data; }).on('end', () => resolve(output));
                    socket.on('connect', () => socket.write(line + '\r\n\r\n'));
                });
                expect(result).toMatch(/^HTTP\/1.1 403/);
            }
        } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
});

it('dials the validated numeric address without resolving the hostname again', async () => {
    const upstream = createServer(socket => socket.on('data', data => socket.write(data)));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const lookup = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const dial = vi.fn(() => createConnection({ host: '127.0.0.1', port: (upstream.address() as { port: number }).port }));
    const proxy = createEgressProxy({ lookup, connect: dial as typeof createConnection });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const socket = createConnection({ host: '127.0.0.1', port: (proxy.address() as { port: number }).port });
    try {
        const result = await new Promise<string>((resolve, reject) => {
            let reply = '';
            socket.on('error', reject).on('data', data => { reply += data; if (reply.includes('synthetic-tunnel')) resolve(reply); });
            socket.on('connect', () => socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\nsynthetic-tunnel'));
        });
        expect(result).toContain('200 Connection Established');
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(dial).toHaveBeenCalledWith({ host: '8.8.8.8', family: 4, port: 443 });
    } finally {
        socket.destroy();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
});
