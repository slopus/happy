import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createBackplane } from "@/modules/backplane/createBackplane";
import { RedisBackplane } from "@/modules/backplane/redisBackplane";

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUnusedPort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to allocate an unused port');
    }

    const { port } = address;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });

    return port;
}

const describeRedis = process.env.REDIS_URL ? describe : describe.skip;

describe('RedisBackplane fail-fast startup', () => {
    it('rejects promptly when Redis is unreachable', async () => {
        const port = await getUnusedPort();
        const start = Date.now();

        await expect(RedisBackplane.create(`redis://127.0.0.1:${port}`)).rejects.toThrow();

        expect(Date.now() - start).toBeLessThan(2_000);
    });
});

describeRedis('RedisBackplane', () => {
    const backplanes: RedisBackplane[] = [];
    const originalRedisUrl = process.env.REDIS_URL;

    afterEach(async () => {
        await Promise.all(backplanes.splice(0).map((backplane) => backplane.destroy()));
        if (originalRedisUrl === undefined) {
            delete process.env.REDIS_URL;
        } else {
            process.env.REDIS_URL = originalRedisUrl;
        }
    });

    it('delivers published messages to subscribers through Redis', async () => {
        const publisher = await RedisBackplane.create(process.env.REDIS_URL!);
        const subscriber = await RedisBackplane.create(process.env.REDIS_URL!);
        backplanes.push(publisher, subscriber);

        const deferred = createDeferred<string>();
        const channel = `hp:user:${randomUUID()}:updates`;

        await subscriber.subscribe(channel, (payload) => {
            deferred.resolve(payload.toString());
        });

        const payload = Buffer.from(JSON.stringify({ type: 'update', id: '1' }));
        await publisher.publish(channel, payload);

        await expect(deferred.promise).resolves.toBe(payload.toString());
    });

    it('supports multiple subscribers on the same Redis channel', async () => {
        const publisher = await RedisBackplane.create(process.env.REDIS_URL!);
        const subscriberA = await RedisBackplane.create(process.env.REDIS_URL!);
        const subscriberB = await RedisBackplane.create(process.env.REDIS_URL!);
        backplanes.push(publisher, subscriberA, subscriberB);

        const channel = `hp:user:${randomUUID()}:ephemeral`;
        const received: string[] = [];
        const allReceived = createDeferred<void>();

        const onReceive = (label: string) => (payload: Buffer) => {
            received.push(`${label}:${payload.toString()}`);
            if (received.length === 2) {
                allReceived.resolve();
            }
        };

        await subscriberA.subscribe(channel, onReceive('a'));
        await subscriberB.subscribe(channel, onReceive('b'));

        await publisher.publish(channel, Buffer.from('fanout'));
        await allReceived.promise;

        expect(received.sort()).toEqual(['a:fanout', 'b:fanout']);
    });

    it('unsubscribes from Redis channels cleanly', async () => {
        const publisher = await RedisBackplane.create(process.env.REDIS_URL!);
        const subscriber = await RedisBackplane.create(process.env.REDIS_URL!);
        backplanes.push(publisher, subscriber);

        const channel = `hp:rpc:req:${randomUUID()}`;
        const received: string[] = [];

        await subscriber.subscribe(channel, (payload) => {
            received.push(payload.toString());
        });
        await subscriber.unsubscribe(channel);
        await publisher.publish(channel, Buffer.from('ignored'));
        await sleep(50);

        expect(received).toEqual([]);
    });

    it('round-trips JSON payloads through Redis transport', async () => {
        const publisher = await RedisBackplane.create(process.env.REDIS_URL!);
        const subscriber = await RedisBackplane.create(process.env.REDIS_URL!);
        backplanes.push(publisher, subscriber);

        const channel = `hp:rpc:res:${randomUUID()}`;
        const deferred = createDeferred<{ ok: boolean; result: { value: number } }>();

        await subscriber.subscribe(channel, (payload) => {
            deferred.resolve(JSON.parse(payload.toString()));
        });

        await publisher.publish(
            channel,
            Buffer.from(JSON.stringify({ ok: true, result: { value: 42 } }))
        );

        await expect(deferred.promise).resolves.toEqual({ ok: true, result: { value: 42 } });
    });

    it('cleans up subscriptions and redis connections on destroy', async () => {
        const publisher = await RedisBackplane.create(process.env.REDIS_URL!);
        const subscriber = await RedisBackplane.create(process.env.REDIS_URL!);
        backplanes.push(publisher, subscriber);

        const channel = `hp:user:${randomUUID()}:updates`;
        const received: string[] = [];

        await subscriber.subscribe(channel, (payload) => {
            received.push(payload.toString());
        });

        expect(await subscriber.isHealthy()).toBe(true);
        await subscriber.destroy();
        await publisher.publish(channel, Buffer.from('ignored'));
        await sleep(50);

        expect(await subscriber.isHealthy()).toBe(false);
        expect(received).toEqual([]);
        await expect(subscriber.publish(channel, Buffer.from('x'))).rejects.toThrow('Backplane has been destroyed');
    });

    it('createBackplane returns RedisBackplane when REDIS_URL is configured', async () => {
        process.env.REDIS_URL = originalRedisUrl!;

        const backplane = await createBackplane();
        backplanes.push(backplane as RedisBackplane);
        expect(backplane).toBeInstanceOf(RedisBackplane);
    });

    it('exposes the publisher redis client for future distributed RPC usage', async () => {
        const backplane = await RedisBackplane.create(process.env.REDIS_URL!);
        backplanes.push(backplane);

        const result = await backplane.getRedis().ping();
        expect(result).toBe('PONG');
    });
});
