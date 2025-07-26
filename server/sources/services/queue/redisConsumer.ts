import { redis } from '@/services/redis';
import { forever } from '@/utils/forever';
import { AsyncLock } from '@/utils/lock';
import { warn } from '@/utils/log';
import { LRUSet } from '@/utils/lru';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { startCleanupWorker } from './redisCleanup';
import { onShutdown, shutdownSignal } from '@/utils/shutdown';
import { delay } from '@/utils/delay';

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const TRIM_INTERVAL = 30000; // 30 seconds

export async function startConsumer(
    stream: string,
    maxSize: number,
    handler: (messages: string[]) => void | Promise<void>
) {
    startCleanupWorker();
    let wasCreated = false;
    const consumerGroup = randomUUID();
    const received = new LRUSet<string>(maxSize); // Should me not longer than queue size
    const client = new Redis(process.env.REDIS_URL!);
    const activeConsumersKey = `active_consumers:${stream}`;
    const lock = new AsyncLock();
    let lastHeartbeat = 0;

    //
    // Start consumer group loop
    //

    forever('redis:' + stream, async () => {

        //
        // Heartbeat
        //

        if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL) {
            lastHeartbeat = Date.now();
            await client.hset(activeConsumersKey, consumerGroup, lastHeartbeat);
        }

        //
        // Create consumer group at current position
        //

        if (!wasCreated) {
            try {
                await client.xgroup('CREATE', stream, consumerGroup, '$', 'MKSTREAM');
            } catch (err: any) {
                // Ignore if group already exists
                if (!err.message?.includes('BUSYGROUP')) {
                    throw err;
                }
            }
            wasCreated = true;
        }

        //
        // Read messages
        //

        const results = await client.xreadgroup(
            'GROUP', consumerGroup, 'consumer',
            'COUNT', 100, // 100 messages
            'BLOCK', 5000, // 5 seconds
            'STREAMS', stream, '>'
        ) as [string, [string, string[]][]][] | null;

        if (!results || results.length === 0) {
            return;
        }

        const [, messages] = results[0];
        if (!messages || messages.length === 0) {
            return;
        }

        // Extract ALL message IDs for acknowledgment
        const allMessageIds: string[] = [];
        const messageContents: string[] = [];

        for (const [messageId, fields] of messages) {
            // Always collect ID for acknowledgment
            allMessageIds.push(messageId);

            // Only process if not already seen
            if (!received.has(messageId) && fields.length >= 2) {
                messageContents.push(fields[1]);
                received.add(messageId);
            }
        }

        // Acknowledge ALL messages at once (including duplicates)
        await redis.xack(stream, consumerGroup, ...allMessageIds);

        // Only call handler if we have new messages to process
        if (messageContents.length === 0) {
            return;
        }

        // Guarantee order of messages
        lock.inLock(async () => {
            try {
                await handler(messageContents);
            } catch (err) {
                warn(err);
            }
        });

    });

    //
    // Start trimmer
    //

    forever('redis:' + stream + ':trimmer', async () => {
        await redis.xtrim(stream, 'MAXLEN', '~', maxSize);
        await delay(TRIM_INTERVAL, shutdownSignal);
    });

    //
    // Clean up on shutdown
    //

    onShutdown('redis:' + stream, async () => {
        try {
            // Destroy consumer group FIRST
            await redis.xgroup('DESTROY', stream, consumerGroup);
            // Then remove from active consumers
            await redis.hdel(activeConsumersKey, consumerGroup);
            // Close the blocking client
            client.disconnect();
        } catch (err) {
            // Ignore
        }
    });

}
