import { afterEach, describe, expect, it } from "vitest";
import { createBackplane } from "@/modules/backplane/createBackplane";
import { MemoryBackplane } from "@/modules/backplane/memoryBackplane";

async function flushMicrotasks() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MemoryBackplane', () => {
    const backplanes: MemoryBackplane[] = [];
    const originalRedisUrl = process.env.REDIS_URL;

    afterEach(async () => {
        await Promise.all(backplanes.splice(0).map((backplane) => backplane.destroy()));
        if (originalRedisUrl === undefined) {
            delete process.env.REDIS_URL;
        } else {
            process.env.REDIS_URL = originalRedisUrl;
        }
    });

    it('delivers published messages to subscribers on the same channel', async () => {
        const publisher = new MemoryBackplane();
        const subscriber = new MemoryBackplane();
        backplanes.push(publisher, subscriber);

        const received: Buffer[] = [];
        await subscriber.subscribe('hp:user:user-1:updates', (payload) => {
            received.push(payload);
        });

        const message = Buffer.from(JSON.stringify({ hello: 'world' }));
        await publisher.publish('hp:user:user-1:updates', message);

        expect(received).toHaveLength(1);
        expect(received[0].toString()).toBe(message.toString());
        expect(received[0]).not.toBe(message);
    });

    it('supports multiple subscribers on the same channel across instances', async () => {
        const publisher = new MemoryBackplane();
        const subscriberA = new MemoryBackplane();
        const subscriberB = new MemoryBackplane();
        backplanes.push(publisher, subscriberA, subscriberB);

        const receivedA: string[] = [];
        const receivedB: string[] = [];

        await subscriberA.subscribe('hp:user:user-1:ephemeral', (payload) => {
            receivedA.push(payload.toString());
        });
        await subscriberB.subscribe('hp:user:user-1:ephemeral', (payload) => {
            receivedB.push(payload.toString());
        });

        await publisher.publish('hp:user:user-1:ephemeral', Buffer.from('first'));

        expect(receivedA).toEqual(['first']);
        expect(receivedB).toEqual(['first']);
    });

    it('unsubscribes a channel cleanly', async () => {
        const publisher = new MemoryBackplane();
        const subscriber = new MemoryBackplane();
        backplanes.push(publisher, subscriber);

        const received: string[] = [];
        await subscriber.subscribe('hp:user:user-1:updates', (payload) => {
            received.push(payload.toString());
        });
        await subscriber.unsubscribe('hp:user:user-1:updates');
        await publisher.publish('hp:user:user-1:updates', Buffer.from('ignored'));

        expect(received).toEqual([]);
    });

    it('round-trips JSON payloads through buffers', async () => {
        const publisher = new MemoryBackplane();
        const subscriber = new MemoryBackplane();
        backplanes.push(publisher, subscriber);

        const received: Array<{ type: string; count: number }> = [];
        await subscriber.subscribe('hp:rpc:req:process-1', (payload) => {
            received.push(JSON.parse(payload.toString()));
        });

        await publisher.publish(
            'hp:rpc:req:process-1',
            Buffer.from(JSON.stringify({ type: 'rpc-request', count: 3 }))
        );

        expect(received).toEqual([{ type: 'rpc-request', count: 3 }]);
    });

    it('cleans up all subscriptions on destroy', async () => {
        const publisher = new MemoryBackplane();
        const subscriber = new MemoryBackplane();
        backplanes.push(publisher, subscriber);

        const received: string[] = [];
        await subscriber.subscribe('hp:user:user-1:updates', (payload) => {
            received.push(payload.toString());
        });

        expect(await subscriber.isHealthy()).toBe(true);
        await subscriber.destroy();
        await publisher.publish('hp:user:user-1:updates', Buffer.from('ignored'));
        await flushMicrotasks();

        expect(await subscriber.isHealthy()).toBe(false);
        expect(received).toEqual([]);
        await expect(subscriber.publish('hp:user:user-1:updates', Buffer.from('x'))).rejects.toThrow('Backplane has been destroyed');
    });

    it('createBackplane returns memory when REDIS_URL is not configured', async () => {
        delete process.env.REDIS_URL;

        const backplane = await createBackplane();
        expect(backplane).toBeInstanceOf(MemoryBackplane);
        await backplane.destroy();
    });

    it('generates a unique process id per instance', async () => {
        const first = new MemoryBackplane();
        const second = new MemoryBackplane();
        backplanes.push(first, second);

        expect(first.getProcessId()).toBeTypeOf('string');
        expect(second.getProcessId()).toBeTypeOf('string');
        expect(first.getProcessId()).not.toBe(second.getProcessId());
    });
});
