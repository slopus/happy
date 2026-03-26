import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { RedisBackplane } from "@/modules/backplane/redisBackplane";
import {
    DistributedRpcRegistry,
    DistributedRpcRegistryOptions,
    getRpcMethodsKey,
    getRpcProcessKey,
} from "@/modules/rpc/distributedRpc";

class MockSocket {
    id: string;
    connected = true;
    timeoutDuration: number | null = null;
    emitWithAck = vi.fn<(event: string, payload: any) => Promise<any>>(async () => undefined);
    timeout = vi.fn((ms: number) => {
        this.timeoutDuration = ms;
        return {
            emitWithAck: this.emitWithAck,
        };
    });

    constructor(id: string) {
        this.id = id;
    }
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

const describeRedis = process.env.REDIS_URL ? describe : describe.skip;

describeRedis('DistributedRpcRegistry', () => {
    const backplanes: RedisBackplane[] = [];
    const registries: DistributedRpcRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.splice(0).map((registry) => registry.destroy()));
        await Promise.all(backplanes.splice(0).map((backplane) => backplane.destroy()));
        vi.clearAllMocks();
    });

    async function createRegistry(
        rpcListeners: Map<string, Map<string, Socket>>,
        options: DistributedRpcRegistryOptions = {},
    ): Promise<{ backplane: RedisBackplane; registry: DistributedRpcRegistry }> {
        const backplane = await RedisBackplane.create(process.env.REDIS_URL!);
        const registry = await DistributedRpcRegistry.create(backplane, rpcListeners, options);
        backplanes.push(backplane);
        registries.push(registry);
        return { backplane, registry };
    }

    it('registers methods in Redis and forwards calls across processes', async () => {
        const userId = `user-${randomUUID()}`;
        const method = `machine-${randomUUID()}:spawn-session`;
        const targetSocket = new MockSocket('target-socket');
        targetSocket.emitWithAck.mockResolvedValue({ sessionId: 'session-1' });

        const targetListeners = new Map<string, Map<string, Socket>>();
        targetListeners.set(userId, new Map([[method, targetSocket as unknown as Socket]]));

        const { registry: targetRegistry, backplane: targetBackplane } = await createRegistry(targetListeners, {
            requestTimeoutMs: 250,
            staleProcessCheckMs: 75,
            heartbeatIntervalMs: 100,
            heartbeatTtlSeconds: 2,
        });
        const { registry: callerRegistry } = await createRegistry(new Map(), {
            requestTimeoutMs: 250,
            staleProcessCheckMs: 75,
            heartbeatIntervalMs: 100,
            heartbeatTtlSeconds: 2,
        });

        await targetRegistry.register(userId, method);

        const result = await callerRegistry.call(userId, method, { prompt: 'hello' });

        expect(result).toEqual({
            ok: true,
            result: { sessionId: 'session-1' },
        });
        expect(targetSocket.timeout).toHaveBeenCalledWith(250);
        expect(targetSocket.emitWithAck).toHaveBeenCalledWith('rpc-request', {
            method,
            params: { prompt: 'hello' },
        });
        expect(await targetBackplane.getRedis().hget(getRpcMethodsKey(userId), method)).toBe(targetRegistry.getProcessId());
    });

    it('returns timeout errors from the remote process', async () => {
        const userId = `user-${randomUUID()}`;
        const method = `machine-${randomUUID()}:permissions`;
        const targetSocket = new MockSocket('target-socket');
        targetSocket.emitWithAck.mockRejectedValue(new Error('operation has timed out'));

        const targetListeners = new Map<string, Map<string, Socket>>();
        targetListeners.set(userId, new Map([[method, targetSocket as unknown as Socket]]));

        const { registry: targetRegistry } = await createRegistry(targetListeners, {
            requestTimeoutMs: 200,
            staleProcessCheckMs: 50,
            heartbeatIntervalMs: 100,
            heartbeatTtlSeconds: 2,
        });
        const { registry: callerRegistry } = await createRegistry(new Map(), {
            requestTimeoutMs: 200,
            staleProcessCheckMs: 50,
            heartbeatIntervalMs: 100,
            heartbeatTtlSeconds: 2,
        });

        await targetRegistry.register(userId, method);

        await expect(callerRegistry.call(userId, method, { path: '/tmp' })).resolves.toEqual({
            ok: false,
            error: 'operation has timed out',
        });
    });

    it('cleans up stale registrations when the target process no longer exists', async () => {
        const userId = `user-${randomUUID()}`;
        const method = `machine-${randomUUID()}:spawn-session`;
        const ghostProcessId = `ghost-${randomUUID()}`;

        const { registry, backplane } = await createRegistry(new Map(), {
            requestTimeoutMs: 200,
            staleProcessCheckMs: 50,
            heartbeatIntervalMs: 100,
            heartbeatTtlSeconds: 2,
        });

        await backplane.getRedis().hset(getRpcMethodsKey(userId), method, ghostProcessId);
        await backplane.getRedis().del(getRpcProcessKey(ghostProcessId));

        await expect(registry.call(userId, method, { prompt: 'hello' })).resolves.toEqual({
            ok: false,
            error: 'RPC method not available',
        });
        expect(await backplane.getRedis().hget(getRpcMethodsKey(userId), method)).toBeNull();
    });

    it('refreshes the process heartbeat while methods remain registered', async () => {
        const userId = `user-${randomUUID()}`;
        const method = `machine-${randomUUID()}:spawn-session`;
        const targetSocket = new MockSocket('target-socket');

        const listeners = new Map<string, Map<string, Socket>>();
        listeners.set(userId, new Map([[method, targetSocket as unknown as Socket]]));

        const { registry, backplane } = await createRegistry(listeners, {
            requestTimeoutMs: 200,
            staleProcessCheckMs: 50,
            heartbeatIntervalMs: 100,
            heartbeatTtlSeconds: 1,
        });

        await registry.register(userId, method);
        await sleep(1_300);

        const remainingTtlMs = await backplane.getRedis().pttl(getRpcProcessKey(registry.getProcessId()));
        expect(remainingTtlMs).toBeGreaterThan(0);
    });

    it('removes process and method keys during destroy', async () => {
        const userIdA = `user-${randomUUID()}`;
        const userIdB = `user-${randomUUID()}`;
        const methodA = `machine-${randomUUID()}:spawn-session`;
        const methodB = `machine-${randomUUID()}:stop-session`;
        const methodC = `machine-${randomUUID()}:permissions`;

        const socketA = new MockSocket('socket-a');
        const socketB = new MockSocket('socket-b');
        const socketC = new MockSocket('socket-c');

        const listeners = new Map<string, Map<string, Socket>>();
        listeners.set(userIdA, new Map([
            [methodA, socketA as unknown as Socket],
            [methodB, socketB as unknown as Socket],
        ]));
        listeners.set(userIdB, new Map([
            [methodC, socketC as unknown as Socket],
        ]));

        const { registry, backplane } = await createRegistry(listeners, {
            requestTimeoutMs: 200,
            staleProcessCheckMs: 50,
            heartbeatIntervalMs: 100,
            heartbeatTtlSeconds: 2,
        });

        await registry.register(userIdA, methodA);
        await registry.register(userIdA, methodB);
        await registry.register(userIdB, methodC);

        const processKey = getRpcProcessKey(registry.getProcessId());
        expect(await backplane.getRedis().exists(processKey)).toBe(1);

        await registry.destroy();
        registries.splice(registries.indexOf(registry), 1);

        expect(await backplane.getRedis().exists(processKey)).toBe(0);
        expect(await backplane.getRedis().hget(getRpcMethodsKey(userIdA), methodA)).toBeNull();
        expect(await backplane.getRedis().hget(getRpcMethodsKey(userIdA), methodB)).toBeNull();
        expect(await backplane.getRedis().hget(getRpcMethodsKey(userIdB), methodC)).toBeNull();
    });
});
