import { redis } from "@/services/redis";

export function createRedisProducer(stream: string) {
    return async (messages: string[]) => {
        if (messages.length === 0) {
            return;
        }

        // Use pipeline for batch publishing
        const pipeline = redis.pipeline();
        for (const message of messages) {
            pipeline.xadd(stream, '*', 'data', message);
        }
        await pipeline.exec();
    }
}