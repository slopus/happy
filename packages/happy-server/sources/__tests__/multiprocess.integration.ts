import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { auth } from "@/app/auth/auth";
import { getUserUpdatesChannel } from "@/modules/backplane/backplane";
import { getRpcMethodsKey, getRpcProcessKey } from "@/modules/rpc/distributedRpc";
import { db } from "@/storage/db";
import { startTestServer, TestServer } from "@/__tests__/helpers/testServer";
import { createTestSocketClient, TestSocketClient } from "@/__tests__/helpers/testSocketClient";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const HANDY_MASTER_SECRET = process.env.HANDY_MASTER_SECRET;
const describeIntegration = DATABASE_URL && REDIS_URL && HANDY_MASTER_SECRET ? describe : describe.skip;

interface TestUser {
    id: string;
    token: string;
}

interface TestSession {
    id: string;
    tag: string;
}

interface TestMachine {
    id: string;
}

let redis: Redis;
let activeServers: TestServer[] = [];
let activeClients: TestSocketClient[] = [];

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRealtimeSubscriptions(): Promise<void> {
    await sleep(150);
}

async function resetDatabase(): Promise<void> {
    const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
    );

    if (tables.length === 0) {
        return;
    }

    const tableList = tables
        .map(({ tablename }) => `\"public\".\"${tablename}\"`)
        .join(', ');

    await db.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

async function resetState(): Promise<void> {
    await resetDatabase();
    await redis.flushdb();
}

async function createTestUser(userId = `user-${randomUUID()}`): Promise<TestUser> {
    await db.account.create({
        data: {
            id: userId,
            publicKey: `pk-${randomUUID()}`,
        },
    });

    return {
        id: userId,
        token: await auth.createToken(userId),
    };
}

async function createSession(userId: string, sessionId = `session-${randomUUID()}`): Promise<TestSession> {
    const tag = `tag-${randomUUID()}`;
    await db.session.create({
        data: {
            id: sessionId,
            accountId: userId,
            tag,
            metadata: `metadata-${sessionId}`,
            agentState: null,
            active: true,
            lastActiveAt: new Date(),
        },
    });

    return { id: sessionId, tag };
}

async function createMachine(userId: string, machineId = `machine-${randomUUID()}`): Promise<TestMachine> {
    await db.machine.create({
        data: {
            id: machineId,
            accountId: userId,
            metadata: `metadata-${machineId}-v1`,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            active: true,
            lastActiveAt: new Date(),
        },
    });

    return { id: machineId };
}

async function createServer(redisEnabled = true): Promise<TestServer> {
    const server = await startTestServer({
        redisUrl: redisEnabled ? REDIS_URL! : null,
        databaseUrl: DATABASE_URL!,
        handyMasterSecret: HANDY_MASTER_SECRET!,
    });
    activeServers.push(server);
    return server;
}

async function createClient(options: Parameters<typeof createTestSocketClient>[0]): Promise<TestSocketClient> {
    const client = await createTestSocketClient(options);
    activeClients.push(client);
    return client;
}

async function postJson(server: TestServer, path: string, token: string, body: unknown) {
    const response = await fetch(`${server.baseUrl}${path}`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    let json: any = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = text;
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${path}: ${JSON.stringify(json)}`);
    }

    return json;
}

async function publishSyntheticUpdate(userId: string, recipientFilter: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
    const eventEnvelope = {
        userId,
        eventName: 'update',
        payload,
        recipientFilter,
    };

    const redisEnvelope = {
        payload: Buffer.from(JSON.stringify(eventEnvelope)).toString('base64'),
    };

    await redis.publish(getUserUpdatesChannel(userId), JSON.stringify(redisEnvelope));
}

async function expectNoMatchingEvent(client: TestSocketClient, eventName: string, predicate: (payload: any) => boolean, waitMs = 250): Promise<void> {
    await sleep(waitMs);
    const matches = client.getEvents(eventName).filter(predicate);
    expect(matches).toHaveLength(0);
}

describeIntegration('multiprocess websocket integration', () => {
    beforeAll(async () => {
        await db.$connect();
        await auth.init();
        redis = new Redis(REDIS_URL!);
        await redis.ping();
    });

    beforeEach(async () => {
        await resetState();
    });

    afterEach(async () => {
        await Promise.all(activeClients.splice(0).map((client) => client.disconnect().catch(() => undefined)));
        await Promise.all(activeServers.splice(0).map((server) => server.stop().catch(() => undefined)));
        await resetState();
    });

    afterAll(async () => {
        await redis.quit();
        await db.$disconnect();
    });

    it('delivers new-message updates across processes', async () => {
        const user = await createTestUser();
        const session = await createSession(user.id);
        const serverA = await createServer(true);
        const serverB = await createServer(true);
        const userClient = await createClient({
            port: serverA.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });

        await waitForRealtimeSubscriptions();
        userClient.clearEvents();

        const response = await postJson(serverB, `/v3/sessions/${session.id}/messages`, user.token, {
            messages: [{ localId: `local-${randomUUID()}`, content: 'encrypted-message' }],
        });

        expect(response.messages).toHaveLength(1);
        const update = await userClient.waitForEvent('update', (payload) => payload?.body?.t === 'new-message', 5_000);
        expect(update.body.t).toBe('new-message');
        expect(update.body.sid).toBe(session.id);
        expect(update.body.message.content).toEqual({ t: 'encrypted', c: 'encrypted-message' });
    });

    it('delivers session activity ephemerals across processes from websocket events', async () => {
        const user = await createTestUser();
        const session = await createSession(user.id);
        const machine = await createMachine(user.id);
        const serverA = await createServer(true);
        const serverB = await createServer(true);

        const userClient = await createClient({
            port: serverA.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });
        await createClient({
            port: serverB.port,
            userId: user.id,
            token: user.token,
            clientType: 'machine-scoped',
            machineId: machine.id,
        });

        await waitForRealtimeSubscriptions();
        userClient.clearEvents();

        const machineClient = activeClients[activeClients.length - 1];
        machineClient.socket.emit('session-alive', {
            sid: session.id,
            time: Date.now(),
            thinking: true,
        });

        const ephemeral = await userClient.waitForEvent('ephemeral', (payload) => payload?.type === 'activity' && payload?.id === session.id, 5_000);
        expect(ephemeral).toEqual(expect.objectContaining({
            type: 'activity',
            id: session.id,
            active: true,
            thinking: true,
        }));
    });

    it('forwards RPC calls across processes', async () => {
        const user = await createTestUser();
        const serverA = await createServer(true);
        const serverB = await createServer(true);
        const daemonMachine = await createMachine(user.id);
        const method = `${daemonMachine.id}:spawn-session`;

        const daemon = await createClient({
            port: serverA.port,
            userId: user.id,
            token: user.token,
            clientType: 'machine-scoped',
            machineId: daemonMachine.id,
        });
        const mobile = await createClient({
            port: serverB.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });

        daemon.socket.on('rpc-request', (data, callback) => {
            callback({
                accepted: true,
                method: data.method,
                params: data.params,
                process: 'daemon-a',
            });
        });

        daemon.socket.emit('rpc-register', { method });
        await daemon.waitForEvent('rpc-registered', (payload) => payload?.method === method, 5_000);

        const response = await mobile.emitWithAck<{ ok: boolean; result?: any; error?: string }>('rpc-call', {
            method,
            params: { prompt: 'hello from mobile' },
        }, 10_000);

        expect(response).toEqual({
            ok: true,
            result: {
                accepted: true,
                method,
                params: { prompt: 'hello from mobile' },
                process: 'daemon-a',
            },
        });
    });

    it('falls back to single-process memory backplane when Redis is not configured', async () => {
        const user = await createTestUser();
        const session = await createSession(user.id);
        const machine = await createMachine(user.id);
        const server = await createServer(false);
        const health = await server.getHealth();

        expect(health.redis).toBe('not configured');

        const userClient = await createClient({
            port: server.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });
        const daemon = await createClient({
            port: server.port,
            userId: user.id,
            token: user.token,
            clientType: 'machine-scoped',
            machineId: machine.id,
        });
        const mobile = await createClient({
            port: server.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });

        await waitForRealtimeSubscriptions();
        userClient.clearEvents();
        daemon.clearEvents();
        mobile.clearEvents();

        await postJson(server, `/v3/sessions/${session.id}/messages`, user.token, {
            messages: [{ localId: `local-${randomUUID()}`, content: 'memory-backplane-message' }],
        });
        const update = await userClient.waitForEvent('update', (payload) => payload?.body?.t === 'new-message', 5_000);
        expect(update.body.message.content).toEqual({ t: 'encrypted', c: 'memory-backplane-message' });

        const method = `${machine.id}:permissions`;
        daemon.socket.on('rpc-request', (_data, callback) => {
            callback({ granted: true });
        });
        daemon.socket.emit('rpc-register', { method });
        await daemon.waitForEvent('rpc-registered', (payload) => payload?.method === method, 5_000);

        const rpcResponse = await mobile.emitWithAck<{ ok: boolean; result?: any; error?: string }>('rpc-call', {
            method,
            params: { path: '/tmp/demo' },
        }, 10_000);
        expect(rpcResponse).toEqual({ ok: true, result: { granted: true } });
    });

    it('applies all recipient filters correctly across processes', async () => {
        const user = await createTestUser();
        const sessionA = await createSession(user.id);
        const sessionB = await createSession(user.id);
        const machineA = await createMachine(user.id);
        const machineB = await createMachine(user.id);
        const serverA = await createServer(true);
        const serverB = await createServer(true);

        const userScopedA = await createClient({
            port: serverA.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });
        const userScopedB = await createClient({
            port: serverB.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });
        const sessionScopedMatch = await createClient({
            port: serverA.port,
            userId: user.id,
            token: user.token,
            clientType: 'session-scoped',
            sessionId: sessionA.id,
        });
        const sessionScopedOther = await createClient({
            port: serverB.port,
            userId: user.id,
            token: user.token,
            clientType: 'session-scoped',
            sessionId: sessionB.id,
        });
        const machineScopedMatch = await createClient({
            port: serverA.port,
            userId: user.id,
            token: user.token,
            clientType: 'machine-scoped',
            machineId: machineA.id,
        });
        const machineScopedOther = await createClient({
            port: serverB.port,
            userId: user.id,
            token: user.token,
            clientType: 'machine-scoped',
            machineId: machineB.id,
        });

        await waitForRealtimeSubscriptions();
        for (const client of [userScopedA, userScopedB, sessionScopedMatch, sessionScopedOther, machineScopedMatch, machineScopedOther]) {
            client.clearEvents();
        }

        await postJson(serverB, `/v3/sessions/${sessionA.id}/messages`, user.token, {
            messages: [{ localId: `local-${randomUUID()}`, content: 'filter-message' }],
        });

        await Promise.all([
            userScopedA.waitForEvent('update', (payload) => payload?.body?.t === 'new-message' && payload?.body?.sid === sessionA.id),
            userScopedB.waitForEvent('update', (payload) => payload?.body?.t === 'new-message' && payload?.body?.sid === sessionA.id),
            sessionScopedMatch.waitForEvent('update', (payload) => payload?.body?.t === 'new-message' && payload?.body?.sid === sessionA.id),
        ]);
        await Promise.all([
            expectNoMatchingEvent(sessionScopedOther, 'update', (payload) => payload?.body?.t === 'new-message' && payload?.body?.sid === sessionA.id),
            expectNoMatchingEvent(machineScopedMatch, 'update', (payload) => payload?.body?.t === 'new-message' && payload?.body?.sid === sessionA.id),
            expectNoMatchingEvent(machineScopedOther, 'update', (payload) => payload?.body?.t === 'new-message' && payload?.body?.sid === sessionA.id),
        ]);

        for (const client of [userScopedA, userScopedB, sessionScopedMatch, sessionScopedOther, machineScopedMatch, machineScopedOther]) {
            client.clearEvents();
        }

        machineScopedOther.socket.emit('session-alive', {
            sid: sessionA.id,
            time: Date.now(),
            thinking: false,
        });

        await Promise.all([
            userScopedA.waitForEvent('ephemeral', (payload) => payload?.type === 'activity' && payload?.id === sessionA.id),
            userScopedB.waitForEvent('ephemeral', (payload) => payload?.type === 'activity' && payload?.id === sessionA.id),
        ]);
        await Promise.all([
            expectNoMatchingEvent(sessionScopedMatch, 'ephemeral', (payload) => payload?.type === 'activity' && payload?.id === sessionA.id),
            expectNoMatchingEvent(sessionScopedOther, 'ephemeral', (payload) => payload?.type === 'activity' && payload?.id === sessionA.id),
            expectNoMatchingEvent(machineScopedMatch, 'ephemeral', (payload) => payload?.type === 'activity' && payload?.id === sessionA.id),
            expectNoMatchingEvent(machineScopedOther, 'ephemeral', (payload) => payload?.type === 'activity' && payload?.id === sessionA.id),
        ]);

        for (const client of [userScopedA, userScopedB, sessionScopedMatch, sessionScopedOther, machineScopedMatch, machineScopedOther]) {
            client.clearEvents();
        }

        const machineUpdateResponse = await machineScopedMatch.emitWithAck<{ result: string; version?: number }>('machine-update-metadata', {
            machineId: machineA.id,
            metadata: 'metadata-machine-a-v2',
            expectedVersion: 1,
        }, 10_000);
        expect(machineUpdateResponse.result).toBe('success');

        await Promise.all([
            userScopedA.waitForEvent('update', (payload) => payload?.body?.t === 'update-machine' && payload?.body?.machineId === machineA.id),
            userScopedB.waitForEvent('update', (payload) => payload?.body?.t === 'update-machine' && payload?.body?.machineId === machineA.id),
            machineScopedMatch.waitForEvent('update', (payload) => payload?.body?.t === 'update-machine' && payload?.body?.machineId === machineA.id),
        ]);
        await Promise.all([
            expectNoMatchingEvent(sessionScopedMatch, 'update', (payload) => payload?.body?.t === 'update-machine' && payload?.body?.machineId === machineA.id),
            expectNoMatchingEvent(sessionScopedOther, 'update', (payload) => payload?.body?.t === 'update-machine' && payload?.body?.machineId === machineA.id),
            expectNoMatchingEvent(machineScopedOther, 'update', (payload) => payload?.body?.t === 'update-machine' && payload?.body?.machineId === machineA.id),
        ]);

        for (const client of [userScopedA, userScopedB, sessionScopedMatch, sessionScopedOther, machineScopedMatch, machineScopedOther]) {
            client.clearEvents();
        }

        const syntheticPayload = {
            id: `update-${randomUUID()}`,
            seq: 999,
            body: {
                t: 'relationship-updated',
                uid: `friend-${randomUUID()}`,
                status: 'friend',
                timestamp: Date.now(),
            },
            createdAt: Date.now(),
        };
        await publishSyntheticUpdate(user.id, { type: 'all-user-authenticated-connections' }, syntheticPayload);

        await Promise.all([
            userScopedA.waitForEvent('update', (payload) => payload?.id === syntheticPayload.id),
            userScopedB.waitForEvent('update', (payload) => payload?.id === syntheticPayload.id),
            sessionScopedMatch.waitForEvent('update', (payload) => payload?.id === syntheticPayload.id),
            sessionScopedOther.waitForEvent('update', (payload) => payload?.id === syntheticPayload.id),
            machineScopedMatch.waitForEvent('update', (payload) => payload?.id === syntheticPayload.id),
            machineScopedOther.waitForEvent('update', (payload) => payload?.id === syntheticPayload.id),
        ]);
    }, 30_000);

    it('recovers from stale RPC registrations after a crashed process disappears', async () => {
        const user = await createTestUser();
        const machine = await createMachine(user.id);
        const serverA = await createServer(true);
        const serverB = await createServer(true);
        const healthA = await serverA.getHealth();
        const method = `${machine.id}:spawn-session`;

        const daemon = await createClient({
            port: serverA.port,
            userId: user.id,
            token: user.token,
            clientType: 'machine-scoped',
            machineId: machine.id,
        });
        const mobile = await createClient({
            port: serverB.port,
            userId: user.id,
            token: user.token,
            clientType: 'user-scoped',
        });

        daemon.socket.on('rpc-request', (_data, callback) => {
            callback({ alive: true });
        });
        daemon.socket.emit('rpc-register', { method });
        await daemon.waitForEvent('rpc-registered', (payload) => payload?.method === method, 5_000);

        expect(await redis.hget(getRpcMethodsKey(user.id), method)).toBe(healthA.processId);

        await serverA.kill();
        activeServers = activeServers.filter((server) => server !== serverA);

        // Simulate the crashed process' heartbeat TTL expiring so the caller exercises
        // the stale-registration cleanup path without waiting 60 seconds in the test suite.
        await redis.del(getRpcProcessKey(healthA.processId));

        const startedAt = Date.now();
        const response = await mobile.emitWithAck<{ ok: boolean; result?: any; error?: string }>('rpc-call', {
            method,
            params: { prompt: 'recover from crash' },
        }, 15_000);
        const durationMs = Date.now() - startedAt;

        expect(response).toEqual({ ok: false, error: 'RPC method not available' });
        expect(durationMs).toBeGreaterThanOrEqual(4_500);
        expect(durationMs).toBeLessThan(12_000);
        expect(await redis.hget(getRpcMethodsKey(user.id), method)).toBeNull();
    }, 20_000);
});
