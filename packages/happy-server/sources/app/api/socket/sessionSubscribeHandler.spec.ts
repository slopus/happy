import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fastify } from '@/app/api/types';
import { startSocket } from '@/app/api/socket';
import { buildUpdateSessionUpdate, eventRouter } from '@/app/events/eventRouter';

// Session id -> owning account.
const { sessions, findMany } = vi.hoisted(() => {
    const sessions: Record<string, string> = { s1: 'u1', s2: 'u1', other: 'u2' };
    const findMany = vi.fn(async ({ where }: any) =>
        (where.id.in as string[]).filter((id) => sessions[id] === where.accountId).map((id) => ({ id })));
    return { sessions, findMany };
});

vi.mock('@/app/auth/auth', () => ({
    // The token is the user id.
    auth: { verifyToken: async (token: string) => ({ userId: token }) }
}));

vi.mock('@/storage/seq', () => {
    let seq = 0;
    return { allocateUserSeq: async () => ++seq, allocateSessionSeq: async () => ++seq };
});

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findMany,
            findUnique: async ({ where }: any) => sessions[where.id] === where.accountId ? { id: where.id } : null
        },
        sessionMessage: {
            findFirst: async () => null,
            create: async ({ data }: any) => ({ id: `msg-${data.seq}`, ...data, createdAt: new Date(), updatedAt: new Date() })
        }
    }
}));

/**
 * Minimal Socket.IO client over the Engine.IO polling transport. Received
 * packets are buffered in arrival order so a test can prove an event was NOT
 * delivered: everything the server sent before a later ack is already buffered
 * once that ack arrives.
 */
class PollingClient {
    private buffer: string[] = [];
    private ackId = 0;

    private constructor(private url: string) { }

    static async connect(base: string, auth: Record<string, string>): Promise<PollingClient> {
        const open = await fetch(base);
        const sid = (JSON.parse((await open.text()).slice(1)) as { sid: string }).sid;
        const client = new PollingClient(`${base}&sid=${sid}`);
        await client.post(`40${JSON.stringify(auth)}`);
        const reply = await client.take((p) => p.startsWith('40') || p.startsWith('44'));
        if (!reply.startsWith('40')) throw new Error(`connect refused: ${reply}`);
        return client;
    }

    private async post(body: string) {
        await (await fetch(this.url, { method: 'POST', body })).text();
    }

    private async take(match: (packet: string) => boolean): Promise<string> {
        while (true) {
            const index = this.buffer.findIndex(match);
            if (index >= 0) return this.buffer.splice(index, 1)[0];
            const packets = (await (await fetch(this.url)).text()).split('\x1e');
            for (const packet of packets) {
                if (packet === '2') await this.post('3'); // Engine.IO heartbeat
                else this.buffer.push(packet);
            }
        }
    }

    emit(event: string, ...args: unknown[]) {
        return this.post(`42${JSON.stringify([event, ...args])}`);
    }

    /** Sends an event that expects an ack and returns the ack id to pass to `ack`. */
    async send(event: string, ...args: unknown[]): Promise<number> {
        const id = this.ackId++;
        await this.post(`42${id}${JSON.stringify([event, ...args])}`);
        return id;
    }

    async ack(id: number): Promise<any> {
        const packet = await this.take((p) => p.startsWith(`43${id}[`));
        return JSON.parse(packet.slice(`43${id}`.length))[0];
    }

    async emitWithAck(event: string, ...args: unknown[]): Promise<any> {
        return this.ack(await this.send(event, ...args));
    }

    /** Waits for an `update` whose body matches. */
    async nextUpdate(match: (body: any) => boolean): Promise<any> {
        const packet = await this.take((p) => isUpdate(p) && match(updateBody(p)));
        return updateBody(packet);
    }

    /** Every `update` the server has sent so far, after a ping round trip flushes the socket. */
    async receivedUpdates(): Promise<any[]> {
        await this.emitWithAck('ping');
        const updates = this.buffer.filter(isUpdate).map(updateBody);
        this.buffer = this.buffer.filter((p) => !isUpdate(p));
        return updates;
    }
}

function isUpdate(packet: string) {
    return packet.startsWith('42["update",');
}

function updateBody(packet: string) {
    return JSON.parse(packet.slice(2))[1].body;
}

function emitSessionUpdate(userId: string, sessionId: string) {
    eventRouter.emitUpdate({
        userId,
        payload: buildUpdateSessionUpdate(sessionId, 1, `upd-${sessionId}`, { value: 'meta', version: 2 }),
        recipientFilter: { type: 'all-interested-in-session', sessionId }
    });
}

describe('session-subscribe over a machine-scoped socket', () => {
    const httpServer = createServer();
    let base = '';
    let machineCount = 0;

    const machine = () => PollingClient.connect(base, { token: 'u1', clientType: 'machine-scoped', machineId: `m${++machineCount}` });
    const app = () => PollingClient.connect(base, { token: 'u1', clientType: 'user-scoped' });

    beforeAll(async () => {
        startSocket({ server: httpServer } as unknown as Fastify);
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/v1/updates/?EIO=4&transport=polling`;
    });

    afterAll(async () => {
        await eventRouter['io'].close();
    });

    it('joins only sessions the account owns, in one query', async () => {
        const daemon = await machine();
        findMany.mockClear();
        const ack = await daemon.emitWithAck('session-subscribe', { sids: ['s1', 's1', 'other', 'nope'] });
        expect(ack).toEqual({ result: 'success', subscribed: ['s1'], missing: ['other', 'nope'] });
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls[0][0].where).toEqual({ accountId: 'u1', id: { in: ['s1', 'other', 'nope'] } });

        // Re-subscribing is idempotent.
        expect(await daemon.emitWithAck('session-subscribe', { sids: ['s1'] }))
            .toEqual({ result: 'success', subscribed: ['s1'], missing: [] });

        emitSessionUpdate('u1', 's1');
        emitSessionUpdate('u2', 'other');
        expect((await daemon.receivedUpdates()).map((u) => u.id)).toEqual(['s1']);
    });

    it('refuses clients that are not machine-scoped', async () => {
        const session = await PollingClient.connect(base, { token: 'u1', clientType: 'session-scoped', sessionId: 's1' });
        for (const client of [await app(), session]) {
            expect(await client.emitWithAck('session-subscribe', { sids: ['s2'] }))
                .toEqual({ result: 'error', reason: 'unsupported-client' });
            expect(await client.emitWithAck('session-unsubscribe', { sids: ['s1'] }))
                .toEqual({ result: 'error', reason: 'unsupported-client' });
        }
        // The session-scoped socket kept its own room.
        emitSessionUpdate('u1', 's1');
        expect((await session.receivedUpdates()).map((u) => u.id)).toEqual(['s1']);
    });

    it('rejects invalid payloads', async () => {
        const daemon = await machine();
        const tooMany = Array.from({ length: 501 }, (_, i) => `s${i}`);
        for (const payload of [null, {}, { sids: [] }, { sids: 's1' }, { sids: [1] }, { sids: tooMany }]) {
            expect(await daemon.emitWithAck('session-subscribe', payload)).toEqual({ result: 'error', reason: 'invalid' });
            expect(await daemon.emitWithAck('session-unsubscribe', payload)).toEqual({ result: 'error', reason: 'invalid' });
        }
    });

    it('delivers new-message and update-session for subscribed sessions only', async () => {
        const daemon = await machine();
        const phone = await app();
        await daemon.emitWithAck('session-subscribe', { sids: ['s1'] });

        await phone.emit('message', { sid: 's1', message: 'ciphertext', localId: 'l1' });
        const message = await daemon.nextUpdate((b) => b.t === 'new-message');
        expect(message).toMatchObject({ sid: 's1', message: { content: { t: 'encrypted', c: 'ciphertext' }, localId: 'l1' } });

        emitSessionUpdate('u1', 's1');
        emitSessionUpdate('u1', 's2');
        expect((await daemon.receivedUpdates()).map((u) => [u.t, u.id])).toEqual([['update-session', 's1']]);
    });

    it('stops delivery after unsubscribe', async () => {
        const daemon = await machine();
        const phone = await app();
        await daemon.emitWithAck('session-subscribe', { sids: ['s1', 's2'] });
        expect(await daemon.emitWithAck('session-unsubscribe', { sids: ['s1'] })).toEqual({ result: 'success' });

        emitSessionUpdate('u1', 's1');
        emitSessionUpdate('u1', 's2');
        expect((await daemon.receivedUpdates()).map((u) => u.id)).toEqual(['s2']);
        // User-scoped sockets still see everything.
        expect((await phone.receivedUpdates()).map((u) => u.id)).toEqual(['s1', 's2']);
    });

    it('applies an unsubscribe sent while a subscribe is still checking ownership', async () => {
        const daemon = await machine();
        let release!: () => void;
        const ownershipChecked = new Promise<void>((resolve) => { release = resolve; });
        findMany.mockClear();
        findMany.mockImplementationOnce(async () => {
            await ownershipChecked;
            return [{ id: 's1' }];
        });

        const subscribe = await daemon.send('session-subscribe', { sids: ['s1'] });
        const unsubscribe = await daemon.send('session-unsubscribe', { sids: ['s1'] });
        await vi.waitFor(() => expect(findMany).toHaveBeenCalledTimes(1));
        release();
        expect(await daemon.ack(subscribe)).toEqual({ result: 'success', subscribed: ['s1'], missing: [] });
        expect(await daemon.ack(unsubscribe)).toEqual({ result: 'success' });

        emitSessionUpdate('u1', 's1');
        expect(await daemon.receivedUpdates()).toEqual([]);
    });

    it('does not echo a message back to the machine socket that sent it', async () => {
        const daemon = await machine();
        const otherDaemon = await machine();
        const phone = await app();
        await daemon.emitWithAck('session-subscribe', { sids: ['s1'] });
        await otherDaemon.emitWithAck('session-subscribe', { sids: ['s1'] });

        await daemon.emit('message', { sid: 's1', message: 'from-daemon', localId: 'l2' });
        await phone.nextUpdate((b) => b.t === 'new-message' && b.message.localId === 'l2');
        await otherDaemon.nextUpdate((b) => b.t === 'new-message' && b.message.localId === 'l2');
        expect(await daemon.receivedUpdates()).toEqual([]);
    });

    it('leaves session-scoped and unsubscribed machine sockets as before', async () => {
        const session = await PollingClient.connect(base, { token: 'u1', clientType: 'session-scoped', sessionId: 's2' });
        const daemon = await machine();

        emitSessionUpdate('u1', 's1');
        emitSessionUpdate('u1', 's2');
        expect((await session.receivedUpdates()).map((u) => u.id)).toEqual(['s2']);
        expect(await daemon.receivedUpdates()).toEqual([]);
    });
});
