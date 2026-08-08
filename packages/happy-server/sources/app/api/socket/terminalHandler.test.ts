import { createServer, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as createClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { terminalHandler, terminalOpQueueSize, withTerminalOpLock } from './terminalHandler';

let httpServer: HttpServer;
let ioServer: Server;
let baseUrl: string;
const sockets: ClientSocket[] = [];

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(
    userId: string,
    clientType: 'user-scoped' | 'machine-scoped',
): Promise<ClientSocket> {
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

beforeAll(async () => {
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    ioServer = new Server(httpServer, { transports: ['websocket'] });
    ioServer.on('connection', (socket) => {
        const auth = (socket.handshake.auth ?? {}) as { userId?: string; clientType?: string };
        socket.data.userId = auth.userId || 'user1';
        socket.data.clientType = auth.clientType || 'user-scoped';
        terminalHandler(socket.data.userId as string, socket, ioServer);
    });
});

afterAll(async () => {
    for (const socket of sockets) {
        socket.close();
    }
    sockets.length = 0;
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('terminalHandler', () => {
    it('serializes terminal writer operations per terminal', async () => {
        const order: string[] = [];
        const key = 'terminal:op:lock-test';

        const first = withTerminalOpLock(key, async () => {
            order.push('forward-start');
            await delay(20);
            order.push('forward-end');
        });
        const second = withTerminalOpLock(key, async () => {
            order.push('takeover');
        });

        await Promise.all([first, second]);
        expect(order).toEqual(['forward-start', 'forward-end', 'takeover']);
        expect(terminalOpQueueSize()).toBe(0);
    });

    it('continues terminal writer operations after an error and cleans the queue', async () => {
        const order: string[] = [];
        const key = 'terminal:op:error-test';

        const failed = withTerminalOpLock(key, async () => {
            order.push('failed-start');
            throw new Error('expected failure');
        });
        const recovered = withTerminalOpLock(key, async () => {
            order.push('recovered');
        });

        await expect(failed).rejects.toThrow('expected failure');
        await recovered;
        expect(order).toEqual(['failed-start', 'recovered']);
        expect(terminalOpQueueSize()).toBe(0);
    });

    it('relays daemon output only to subscribed clients of the same user', async () => {
        const daemon = await connect('user1', 'machine-scoped');
        const client = await connect('user1', 'user-scoped');
        const stranger = await connect('user2', 'user-scoped');
        const terminalId = 'term-relay';

        daemon.emit('terminal:register', { terminalId });
        client.emit('terminal:subscribe', { terminalId });
        stranger.emit('terminal:subscribe', { terminalId });
        await delay(50);

        const outputPromise = new Promise<string>((resolve) => {
            client.on('terminal:output', (data: { payload: string }) => resolve(data.payload));
        });
        let strangerGotOutput = false;
        stranger.on('terminal:output', () => {
            strangerGotOutput = true;
        });

        daemon.emit('terminal:output', { terminalId, payload: 'ENCRYPTED-1' });
        await expect(outputPromise).resolves.toBe('ENCRYPTED-1');
        await delay(100);
        expect(strangerGotOutput).toBe(false);
    });

    it('relays exit frames to subscribed clients', async () => {
        const daemon = await connect('user1', 'machine-scoped');
        const client = await connect('user1', 'user-scoped');
        const terminalId = 'term-exit';

        daemon.emit('terminal:register', { terminalId });
        client.emit('terminal:subscribe', { terminalId });
        await delay(50);

        const exitPromise = new Promise<string>((resolve) => {
            client.on('terminal:exit', (data: { payload: string }) => resolve(data.payload));
        });
        daemon.emit('terminal:exit', { terminalId, payload: 'ENCRYPTED-EXIT' });
        await expect(exitPromise).resolves.toBe('ENCRYPTED-EXIT');
    });

    it('relays encrypted daemon epoch announcements to subscribed clients', async () => {
        const daemon = await connect('user1', 'machine-scoped');
        const client = await connect('user1', 'user-scoped');
        const terminalId = 'term-epoch';

        daemon.emit('terminal:register', { terminalId });
        client.emit('terminal:subscribe', { terminalId });
        await delay(50);

        const epochPromise = new Promise<string>((resolve) => {
            client.on('terminal:epoch', (data: { payload: string }) => resolve(data.payload));
        });
        daemon.emit('terminal:epoch', { terminalId, payload: 'ENCRYPTED-EPOCH' });
        await expect(epochPromise).resolves.toBe('ENCRYPTED-EPOCH');
    });

    it('enforces a single writer seat and forwards only writer input', async () => {
        const daemon = await connect('user1', 'machine-scoped');
        const clientA = await connect('user1', 'user-scoped');
        const clientB = await connect('user1', 'user-scoped');
        const terminalId = 'term-writer';

        daemon.emit('terminal:register', { terminalId });
        clientA.emit('terminal:subscribe', { terminalId });
        clientB.emit('terminal:subscribe', { terminalId });
        await delay(50);

        const daemonInputs: string[] = [];
        daemon.on('terminal:input', (data: { payload: string }) => daemonInputs.push(data.payload));

        // A takes the writer seat and its input reaches the daemon.
        clientA.emit('terminal:takeover', { terminalId });
        await delay(50);
        clientA.emit('terminal:input', { terminalId, payload: 'FROM-A' });
        await delay(100);
        expect(daemonInputs).toContain('FROM-A');

        // B is view-only until takeover.
        clientB.emit('terminal:input', { terminalId, payload: 'FROM-B-VIEW' });
        await delay(100);
        expect(daemonInputs).not.toContain('FROM-B-VIEW');

        // B takes over; A is demoted and every client sees the new writer.
        const writerNotice = new Promise<string>((resolve) => {
            clientA.on('terminal:writer', (data: { writerSocketId: string }) => resolve(data.writerSocketId));
        });
        clientB.emit('terminal:takeover', { terminalId });
        await expect(writerNotice).resolves.toBe(clientB.id);
        await delay(50);

        clientB.emit('terminal:input', { terminalId, payload: 'FROM-B' });
        clientA.emit('terminal:input', { terminalId, payload: 'FROM-A-VIEW' });
        await delay(100);
        expect(daemonInputs).toContain('FROM-B');
        expect(daemonInputs).not.toContain('FROM-A-VIEW');
    });

    it('resolves concurrent takeovers to exactly one writer', async () => {
        const daemon = await connect('user1', 'machine-scoped');
        const clientA = await connect('user1', 'user-scoped');
        const clientB = await connect('user1', 'user-scoped');
        const terminalId = 'term-race';

        daemon.emit('terminal:register', { terminalId });
        clientA.emit('terminal:subscribe', { terminalId });
        clientB.emit('terminal:subscribe', { terminalId });
        await delay(50);

        const daemonInputs: string[] = [];
        daemon.on('terminal:input', (data: { payload: string }) => daemonInputs.push(data.payload));

        // Fire both takeovers without waiting: takeover must be serialized and
        // end with exactly one writer, never zero or two.
        clientA.emit('terminal:takeover', { terminalId });
        clientB.emit('terminal:takeover', { terminalId });
        await delay(100);

        clientA.emit('terminal:input', { terminalId, payload: 'FROM-A' });
        clientB.emit('terminal:input', { terminalId, payload: 'FROM-B' });
        await delay(100);

        expect(daemonInputs).toHaveLength(1);
        expect(['FROM-A', 'FROM-B']).toContain(daemonInputs[0]);
    });

    it('clears the writer seat on unsubscribe', async () => {
        const daemon = await connect('user1', 'machine-scoped');
        const clientA = await connect('user1', 'user-scoped');
        const clientB = await connect('user1', 'user-scoped');
        const terminalId = 'term-unsub';

        daemon.emit('terminal:register', { terminalId });
        clientA.emit('terminal:subscribe', { terminalId });
        clientB.emit('terminal:subscribe', { terminalId });
        await delay(50);

        const daemonInputs: string[] = [];
        daemon.on('terminal:input', (data: { payload: string }) => daemonInputs.push(data.payload));

        clientA.emit('terminal:takeover', { terminalId });
        await delay(50);
        clientA.emit('terminal:unsubscribe', { terminalId });
        await delay(50);
        clientA.emit('terminal:input', { terminalId, payload: 'FROM-A-AFTER' });
        await delay(100);
        expect(daemonInputs).toEqual([]);

        clientB.emit('terminal:takeover', { terminalId });
        await delay(50);
        clientB.emit('terminal:input', { terminalId, payload: 'FROM-B' });
        await delay(100);
        expect(daemonInputs).toEqual(['FROM-B']);
    });

    it('drops malformed terminal ids and empty payloads', async () => {
        const daemon = await connect('user1', 'machine-scoped');
        const client = await connect('user1', 'user-scoped');
        const terminalId = 'ok-terminal';

        daemon.emit('terminal:register', { terminalId });
        client.emit('terminal:subscribe', { terminalId });
        await delay(50);

        let received = 0;
        client.on('terminal:output', () => {
            received++;
        });

        daemon.emit('terminal:output', { terminalId: 'bad id!', payload: 'X' });
        daemon.emit('terminal:output', { terminalId, payload: '' });
        daemon.emit('terminal:output', { terminalId, payload: 'OK' });
        await delay(100);
        expect(received).toBe(1);
    });
});
