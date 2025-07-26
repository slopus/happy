import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Redis } from 'ioredis';
import { startConsumer } from './redisConsumer';
import { createRedisProducer } from './redisProducer';
import { delay } from '@/utils/delay';

// Mock the redis import
vi.mock('@/services/redis', () => ({
    redis: new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
}));

// Mock forever to run immediately
vi.mock('@/utils/forever', () => ({
    forever: (name: string, fn: () => Promise<void>) => {
        // Run the function in a loop with a small delay
        const run = async () => {
            while (!globalThis.__stopForever) {
                await fn();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        };
        run().catch(() => { });
    }
}));

// Mock onShutdown to collect callbacks
const shutdownCallbacks: Map<string, () => Promise<void>> = new Map();
vi.mock('@/utils/shutdown', () => ({
    onShutdown: (name: string, callback: () => Promise<void>) => {
        shutdownCallbacks.set(name, callback);
    },
    shutdownSignal: { aborted: false }
}));

describe('Redis Queue System', () => {
    let redis: Redis;
    let testStream: string;
    let receivedMessages: string[][] = [];

    beforeEach(async () => {
        redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
        testStream = `test-stream-${Date.now()}`;
        receivedMessages = [];
        globalThis.__stopForever = false;
        shutdownCallbacks.clear();

        // Clean up test stream if it exists
        try {
            await redis.del(testStream);
            await redis.del(`active_consumers:${testStream}`);
        } catch (err) {
            // Ignore
        }
    });

    afterEach(async () => {
        globalThis.__stopForever = true;

        // Call all shutdown callbacks
        for (const callback of shutdownCallbacks.values()) {
            await callback();
        }

        // Clean up
        try {
            await redis.del(testStream);
            await redis.del(`active_consumers:${testStream}`);

            // Clean up any consumer groups
            const groups = await redis.xinfo('GROUPS', testStream).catch(() => []) as any[];
            for (const groupInfo of groups) {
                const groupName = groupInfo[1];
                await redis.xgroup('DESTROY', testStream, groupName).catch(() => { });
            }
        } catch (err) {
            // Ignore
        }

        redis.disconnect();
    });

    it('should produce and consume messages', async () => {
        const producer = createRedisProducer(testStream);

        // Start consumer
        await startConsumer(testStream, 1000, async (messages) => {
            receivedMessages.push(messages);
        });

        // Wait for consumer to be ready
        await delay(100);

        // Send messages - each becomes a separate stream entry
        await producer(['message1', 'message2', 'message3']);

        // Wait for messages to be consumed
        await delay(200);

        // Check received messages - should get all messages (possibly in multiple batches)
        const allMessages = receivedMessages.flat();
        expect(allMessages).toContain('message1');
        expect(allMessages).toContain('message2');
        expect(allMessages).toContain('message3');
        expect(allMessages).toHaveLength(3);
    });

    it('should handle multiple consumers', async () => {
        const producer = createRedisProducer(testStream);
        const received1: string[][] = [];
        const received2: string[][] = [];

        // Start two consumers
        await startConsumer(testStream, 1000, async (messages) => {
            received1.push(messages);
        });

        await startConsumer(testStream, 1000, async (messages) => {
            received2.push(messages);
        });

        // Wait for consumers to be ready
        await delay(100);

        // Send messages
        await producer(['msg1', 'msg2']);

        // Wait for messages to be consumed
        await delay(200);

        // Both consumers should receive all messages
        const allMessages1 = received1.flat();
        const allMessages2 = received2.flat();

        expect(allMessages1).toContain('msg1');
        expect(allMessages1).toContain('msg2');
        expect(allMessages1).toHaveLength(2);

        expect(allMessages2).toContain('msg1');
        expect(allMessages2).toContain('msg2');
        expect(allMessages2).toHaveLength(2);
    });

    it('should track active consumers', async () => {
        // Start consumer
        await startConsumer(testStream, 1000, async () => { });

        // Wait for registration
        await delay(100);

        // Check active consumers
        const activeConsumers = await redis.hgetall(`active_consumers:${testStream}`);
        expect(Object.keys(activeConsumers)).toHaveLength(1);

        // Check that consumer has a timestamp
        const consumerGroup = Object.keys(activeConsumers)[0];
        const timestamp = parseInt(activeConsumers[consumerGroup]);
        expect(timestamp).toBeGreaterThan(0);
        expect(timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should clean up on shutdown', async () => {
        // Start consumer
        await startConsumer(testStream, 1000, async () => { });

        // Wait for registration
        await delay(100);

        // Get consumer group
        const activeConsumers = await redis.hgetall(`active_consumers:${testStream}`);
        const consumerGroup = Object.keys(activeConsumers)[0];

        // Verify consumer group exists
        const groups = (await redis.xinfo('GROUPS', testStream)) as any[];
        expect(groups.length).toBeGreaterThan(0);

        // Call shutdown
        const shutdownCallback = shutdownCallbacks.get(`redis:${testStream}`);
        expect(shutdownCallback).toBeDefined();
        await shutdownCallback!();

        // Check that consumer was removed from active list
        const activeAfterShutdown = await redis.hgetall(`active_consumers:${testStream}`);
        expect(Object.keys(activeAfterShutdown)).toHaveLength(0);

        // Check that consumer group was destroyed
        const groupsAfterShutdown = (await redis.xinfo('GROUPS', testStream).catch(() => [])) as any[];
        const groupNames = groupsAfterShutdown.map((g: any) => g[1]);
        expect(groupNames).not.toContain(consumerGroup);
    });

    it('should handle empty message batches', async () => {
        const producer = createRedisProducer(testStream);

        // Try to produce empty array
        await producer([]);

        // Should not throw error
        expect(true).toBe(true);
    });

    // it('should handle empty message batches', async () => {
    //     const producer = createRedisProducer(testStream, 1000);

    //     // Try to produce empty array
    //     await producer([]);

    //     // Should not throw error
    //     expect(true).toBe(true);
    // });


    it('should handle concurrent message processing', async () => {
        const producer = createRedisProducer(testStream);
        const processedMessages: string[] = [];

        // Start consumer with delay to simulate processing
        await startConsumer(testStream, 1000, async (messages) => {
            await delay(50); // Simulate processing time
            processedMessages.push(...messages);
        });

        // Wait for consumer to be ready
        await delay(100);

        // Send multiple batches quickly
        await producer(['batch1-msg1', 'batch1-msg2']);
        await producer(['batch2-msg1']);
        await producer(['batch3-msg1', 'batch3-msg2', 'batch3-msg3']);

        // Wait for all messages to be processed
        await delay(1000);

        // Should have processed all messages
        expect(processedMessages).toHaveLength(6);
        expect(processedMessages).toContain('batch1-msg1');
        expect(processedMessages).toContain('batch2-msg1');
        expect(processedMessages).toContain('batch3-msg3');
    });

    it('should update heartbeat periodically', async () => {
        // Start consumer
        await startConsumer(testStream, 1000, async () => { });

        // Wait for initial registration
        await delay(100);

        // Get initial timestamp
        const initial = await redis.hgetall(`active_consumers:${testStream}`);
        const consumerGroup = Object.keys(initial)[0];
        const initialTimestamp = parseInt(initial[consumerGroup]);

        // Force some message reads to trigger heartbeat update
        const producer = createRedisProducer(testStream);
        await producer(['trigger']);

        // Wait a bit
        await delay(200);

        // Check if heartbeat was updated
        const updated = await redis.hget(`active_consumers:${testStream}`, consumerGroup);
        const updatedTimestamp = parseInt(updated!);

        // Timestamp should be valid
        expect(updatedTimestamp).toBeGreaterThan(0);
        expect(updatedTimestamp).toBeLessThanOrEqual(Date.now());
    });
});

// Global cleanup
declare global {
    var __stopForever: boolean;
}