import * as crypto from 'crypto';
import { Redis } from 'ioredis';

export type RedisEval = (script: string, keyCount: number, key: string, windowMs: string) => Promise<unknown>;
type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

const REDIS_FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

let sharedRedis: Redis | null | undefined;

function redisEvalFromEnvironment(): RedisEval | null {
    if (!process.env.REDIS_URL) return null;
    if (sharedRedis === undefined) sharedRedis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
    return async (script, keyCount, key, windowMs) => {
        if (sharedRedis!.status === 'wait') await sharedRedis!.connect();
        return sharedRedis!.eval(script, keyCount, key, windowMs);
    };
}

export function createPublicShareRateLimiter(options: {
    scope: string;
    max: number;
    windowMs: number;
    maxLocalEntries?: number;
    now?: () => number;
    redisEval?: RedisEval | null;
}) {
    const now = options.now ?? Date.now;
    const localEntries = new Map<string, { count: number; windowStart: number }>();
    const redisEval = options.redisEval === undefined ? redisEvalFromEnvironment() : options.redisEval;
    const maxLocalEntries = options.maxLocalEntries ?? 10_000;

    function pruneLocalEntries(currentTime: number): void {
        for (const [key, entry] of localEntries) {
            if (currentTime - entry.windowStart >= options.windowMs) localEntries.delete(key);
        }
        while (localEntries.size >= maxLocalEntries) {
            const oldest = localEntries.keys().next().value as string | undefined;
            if (!oldest) break;
            localEntries.delete(oldest);
        }
    }

    return {
        async check(identifier: string): Promise<RateLimitResult> {
            const digest = crypto.createHash('sha256').update(`${options.scope}:${identifier}`).digest('hex');
            if (redisEval) {
                const result = await redisEval(
                    REDIS_FIXED_WINDOW_SCRIPT,
                    1,
                    `happy:public-share-rate:${options.scope}:${digest}`,
                    String(options.windowMs),
                );
                const [count, ttl] = Array.isArray(result) ? result.map(Number) : [options.max + 1, options.windowMs];
                return {
                    allowed: count <= options.max,
                    retryAfterSeconds: Math.max(1, Math.ceil(Math.max(0, ttl) / 1000)),
                };
            }

            const currentTime = now();
            const entry = localEntries.get(digest);
            if (!entry || currentTime - entry.windowStart >= options.windowMs) {
                pruneLocalEntries(currentTime);
                localEntries.set(digest, { count: 1, windowStart: currentTime });
                return { allowed: true, retryAfterSeconds: Math.ceil(options.windowMs / 1000) };
            }
            entry.count += 1;
            return {
                allowed: entry.count <= options.max,
                retryAfterSeconds: Math.max(1, Math.ceil((options.windowMs - (currentTime - entry.windowStart)) / 1000)),
            };
        },
        localEntryCount(): number {
            return localEntries.size;
        },
    };
}
