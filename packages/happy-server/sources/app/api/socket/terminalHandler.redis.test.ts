import { createServer, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { io as createClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { terminalHandler } from './terminalHandler';

interface WriterState {
    writerSocketId: string | null;
    generation: number;
    isWriter: boolean;
}

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('terminalHandler Redis writer leases', () => {
    let httpServer: HttpServer;
    let ioServer: Server;
    let baseUrl: string;
    let redis: Redis;
    const sockets: ClientSocket[] = [];

    const userId = `redis-user-${process.pid}`;
    const terminalId = 'redis-writer-lease';
    const key = `terminal:writer:${userId}:${terminalId}`;

    async function connect(clientType: 'user-scoped' | 'machine-scoped'): Promise<ClientSocket> {
        const socket = createClient(baseUrl, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
            auth: { userId, clientType },
        });
        await new Promise<void>((resolve, reject) => {
            socket.on('connect', () => resolve());
            socket.on('connect_error', reject);
        });
        sockets.push(socket);
        return socket;
    }

    async function subscribe(socket: ClientSocket): Promise<WriterState> {
        return await socket.emitWithAck('terminal:subscribe', { terminalId }) as WriterState;
    }

    async function takeover(socket: ClientSocket): Promise<WriterState> {
        return await socket.emitWithAck('terminal:takeover', { terminalId }) as WriterState;
    }

    async function waitForValue(expected: string | null): Promise<void> {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
            if (await redis.get(key) === expected) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(await redis.get(key)).toBe(expected);
    }

    beforeAll(async () => {
        redis = new Redis(redisUrl!);
        await redis.del(key);
        httpServer = createServer();
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
        ioServer = new Server(httpServer, { transports: ['websocket'] });
        ioServer.on('connection', (socket) => {
            socket.data.clientType = socket.handshake.auth.clientType;
            terminalHandler(userId, socket, ioServer);
        });
    });

    afterAll(async () => {
        for (const socket of sockets) {
            socket.close();
        }
        await redis.del(key);
        await redis.quit();
        await new Promise<void>((resolve) => ioServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it('tracks the latest exact lease through takeover, unsubscribe, disconnect, and races', async () => {
        const daemon = await connect('machine-scoped');
        const clientA = await connect('user-scoped');
        const clientB = await connect('user-scoped');
        const clientC = await connect('user-scoped');
        daemon.emit('terminal:register', { terminalId });

        const stateA = await subscribe(clientA);
        const stateB = await subscribe(clientB);
        await subscribe(clientC);
        expect(stateA).toEqual(expect.objectContaining({
            writerSocketId: clientA.id,
            generation: 1,
            isWriter: true,
        }));
        expect(stateB.isWriter).toBe(false);
        expect(await redis.get(key)).toBe(`${clientA.id}:1`);

        const takeoverB1 = await takeover(clientB);
        const takeoverB2 = await takeover(clientB);
        expect(takeoverB1.generation).toBe(2);
        expect(takeoverB2.generation).toBe(3);
        expect(await redis.get(key)).toBe(`${clientB.id}:3`);

        clientA.emit('terminal:unsubscribe', { terminalId });
        await waitForValue(`${clientB.id}:3`);

        const unsubscribeNotice = new Promise<void>((resolve) => {
            clientC.on('terminal:writer', (state: WriterState) => {
                if (state.writerSocketId === null) {
                    resolve();
                }
            });
        });
        clientB.emit('terminal:unsubscribe', { terminalId });
        await unsubscribeNotice;
        await waitForValue(null);

        const takeoverC = await takeover(clientC);
        expect(takeoverC).toEqual(expect.objectContaining({
            writerSocketId: clientC.id,
            isWriter: true,
        }));
        const clientD = await connect('user-scoped');
        await subscribe(clientD);
        const disconnectNotice = new Promise<void>((resolve) => {
            clientD.on('terminal:writer', (state: WriterState) => {
                if (state.writerSocketId === null) {
                    resolve();
                }
            });
        });
        clientC.close();
        await disconnectNotice;
        await waitForValue(null);

        const clientE = await connect('user-scoped');
        await subscribe(clientE);
        await Promise.all([takeover(clientD), takeover(clientE)]);
        const finalValue = await redis.get(key);
        expect([`${clientD.id}:3`, `${clientE.id}:3`]).toContain(finalValue);

        const daemonInputs: string[] = [];
        daemon.on('terminal:input', (data: { payload: string }) => daemonInputs.push(data.payload));
        await redis.expire(key, 1);
        clientD.emit('terminal:input', { terminalId, payload: 'FROM-D' });
        clientE.emit('terminal:input', { terminalId, payload: 'FROM-E' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(daemonInputs).toHaveLength(1);
        expect(['FROM-D', 'FROM-E']).toContain(daemonInputs[0]);
        expect(await redis.ttl(key)).toBeGreaterThan(60);
    });
});
