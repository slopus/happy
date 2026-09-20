import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { socketServerOptions } from '@/app/api/socketConfig';

// Drives the real Engine.IO polling transport over plain HTTP, because the
// server deliberately ships no Socket.IO client dependency.
describe('socket server packet limit', () => {
    it('carries an encrypted metadata packet past the 1 MB Engine.IO default and stays bounded at 8 MiB', async () => {
        const httpServer = createServer();
        const io = new Server(httpServer, socketServerOptions);
        const received = new Promise<number>((resolve) => {
            io.on('connection', (socket) => {
                socket.on('metadata', (value: string) => resolve(value.length));
            });
        });
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        const port = (httpServer.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}/v1/updates/?EIO=4&transport=polling`;
        try {
            const open = await fetch(base);
            const sid = (JSON.parse((await open.text()).slice(1)) as { sid: string }).sid;
            const post = (body: string) => fetch(`${base}&sid=${sid}`, { method: 'POST', body });
            expect(await (await post('40')).text()).toBe('ok'); // namespace connect
            await (await fetch(`${base}&sid=${sid}`)).text(); // drain the connect ack

            // A session draft near the daemon's 1,000,000-character limit arrives
            // as one encrypted base64 packet well past the old 1,000,000-byte
            // default, which answered it with 413 and broke synchronization.
            const accepted = await post(`42["metadata","${'a'.repeat(1_400_000)}"]`);
            expect(accepted.status).toBe(200);
            expect(await received).toBe(1_400_000);

            // The limit is a bound, not unlimited: past 8 MiB the engine refuses.
            const refused = await post(`42["metadata","${'a'.repeat(9 * 1024 * 1024)}"]`);
            expect(refused.status).toBe(413);
        } finally {
            await io.close();
        }
    });
});
