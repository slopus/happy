/**
 * Tracks mobile app focus state per socket connection.
 * Used by push dispatch to suppress notifications when the app is in foreground.
 *
 * When REDIS_URL is set, state is stored in a Redis hash so all replicas
 * see the same view. Without Redis (standalone mode), falls back to an
 * in-process Map — sufficient for single-process deployments.
 *
 * Redis key: `push:focus` (hash, field = socketId, value = "active" | "background").
 * Entries are cleaned up on disconnect; a 1-hour TTL on the hash acts as a
 * safety net against leaked entries from crashed replicas.
 */

import { Redis } from 'ioredis';

type AppFocusState = 'active' | 'background';

const REDIS_KEY = 'push:focus';
const TTL_SECONDS = 3600;

// In-memory fallback (always kept in sync for local-replica fast path)
const localState = new Map<string, AppFocusState>();

let redisClient: Redis | null = null;

if (process.env.REDIS_URL) {
    redisClient = new Redis(process.env.REDIS_URL);
}

export function setFocusState(socketId: string, state: AppFocusState): void {
    localState.set(socketId, state);
    if (redisClient) {
        void redisClient.hset(REDIS_KEY, socketId, state).then(() => {
            void redisClient!.expire(REDIS_KEY, TTL_SECONDS);
        });
    }
}

export function clearFocusState(socketId: string): void {
    localState.delete(socketId);
    if (redisClient) {
        void redisClient.hdel(REDIS_KEY, socketId);
    }
}

/**
 * Check if a socket is in foreground. Checks local Map first (fast path),
 * then falls back to Redis for cross-replica visibility.
 */
export async function isForeground(socketId: string): Promise<boolean> {
    const local = localState.get(socketId);
    if (local !== undefined) {
        return local === 'active';
    }
    if (redisClient) {
        const val = await redisClient.hget(REDIS_KEY, socketId);
        return val === 'active';
    }
    return false;
}
