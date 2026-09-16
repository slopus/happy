import { MMKV } from 'react-native-mmkv';
import { accountStorageId } from '@/auth/accountRuntime';
import { z } from 'zod';
import { ApiMessageSchema, ApiSessionSnapshotSchema, type ApiMessage, type ApiSessionSnapshot } from './apiTypes';
import { sessionHistoryPageCache } from './sessionHistoryPageCache';

const cacheStorage = new MMKV({ id: accountStorageId('session-warm-cache')! });
const CACHE_KEY = 'encrypted-wire-v1';
const MAX_SNAPSHOTS = 150;
const MAX_LATEST_PAGES = 3;

export function createSessionWarmCacheAccountKey(serverUrl: string, accountId: string): string {
    let serverOrigin: string;
    try {
        serverOrigin = new URL(serverUrl).origin;
    } catch {
        serverOrigin = serverUrl.trim().replace(/\/+$/, '');
    }
    return `${serverOrigin}|${accountId}`;
}

const latestPageSchema = z.object({
    messages: z.array(ApiMessageSchema),
    hasMore: z.boolean(),
});

const warmCacheSchema = z.object({
    version: z.literal(1),
    accountId: z.string(),
    snapshots: z.array(ApiSessionSnapshotSchema),
    latestPages: z.record(z.string(), latestPageSchema),
    latestOrder: z.array(z.string()),
});

type LatestPage = { messages: ApiMessage[]; hasMore: boolean };
type WarmCache = z.infer<typeof warmCacheSchema>;

const emptyCache = (accountId: string): WarmCache => ({
    version: 1,
    accountId,
    snapshots: [],
    latestPages: {},
    latestOrder: [],
});

function read(accountId: string): WarmCache {
    try {
        const encoded = cacheStorage.getString(CACHE_KEY);
        if (!encoded) return emptyCache(accountId);
        const parsed = warmCacheSchema.safeParse(JSON.parse(encoded));
        if (!parsed.success || parsed.data.accountId !== accountId) {
            clearSessionWarmCache();
            return emptyCache(accountId);
        }
        return parsed.data;
    } catch {
        return emptyCache(accountId);
    }
}

function write(cache: WarmCache): void {
    // Disk quota/private browsing failures must never interrupt live sync.
    try { cacheStorage.set(CACHE_KEY, JSON.stringify(cache)); } catch { /* optional cache */ }
}

export function loadSessionWarmCache(accountId: string): {
    snapshots: ApiSessionSnapshot[];
    latestPages: Record<string, LatestPage>;
} {
    const cache = read(accountId);
    return { snapshots: cache.snapshots, latestPages: cache.latestPages };
}

export function saveSessionWarmSnapshots(accountId: string, snapshots: ApiSessionSnapshot[]): void {
    const cache = read(accountId);
    const byId = new Map(cache.snapshots.map((snapshot) => [snapshot.id, snapshot]));
    for (const snapshot of snapshots) {
        const existing = byId.get(snapshot.id);
        if (!existing || snapshot.seq > existing.seq
            || (snapshot.seq === existing.seq && snapshot.updatedAt >= existing.updatedAt)) {
            byId.set(snapshot.id, snapshot);
        }
    }
    cache.snapshots = [...byId.values()]
        .sort((a, b) => b.activeAt - a.activeAt)
        .slice(0, MAX_SNAPSHOTS);
    write(cache);
}

export function saveSessionWarmLatestPage(
    accountId: string,
    sessionId: string,
    page: LatestPage,
): void {
    const cache = read(accountId);
    cache.latestPages[sessionId] = {
        messages: [...page.messages].sort((a, b) => a.seq - b.seq).slice(-100),
        hasMore: page.hasMore || page.messages.length > 100,
    };
    cache.latestOrder = cache.latestOrder.filter((id) => id !== sessionId);
    cache.latestOrder.push(sessionId);
    while (cache.latestOrder.length > MAX_LATEST_PAGES) {
        const evicted = cache.latestOrder.shift();
        if (evicted) delete cache.latestPages[evicted];
    }
    write(cache);
}

export function appendSessionWarmMessages(accountId: string, sessionId: string, messages: ApiMessage[]): void {
    const cache = read(accountId);
    const existing = cache.latestPages[sessionId];
    if (!existing) return;
    const bySeq = new Map(existing.messages.map((message) => [message.seq, message]));
    for (const message of messages) bySeq.set(message.seq, message);
    cache.latestPages[sessionId] = {
        messages: [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-100),
        hasMore: existing.hasMore || bySeq.size > 100,
    };
    cache.latestOrder = cache.latestOrder.filter((id) => id !== sessionId);
    cache.latestOrder.push(sessionId);
    write(cache);
}

export function touchSessionWarmLatestPage(accountId: string, sessionId: string): void {
    const cache = read(accountId);
    if (!cache.latestPages[sessionId]) return;
    cache.latestOrder = cache.latestOrder.filter((id) => id !== sessionId);
    cache.latestOrder.push(sessionId);
    write(cache);
}

export function removeSessionFromWarmCache(accountId: string, sessionId: string): void {
    sessionHistoryPageCache.remove(accountId, sessionId);
    const cache = read(accountId);
    cache.snapshots = cache.snapshots.filter((snapshot) => snapshot.id !== sessionId);
    delete cache.latestPages[sessionId];
    cache.latestOrder = cache.latestOrder.filter((id) => id !== sessionId);
    write(cache);
}

export function clearSessionWarmCache(): void {
    sessionHistoryPageCache.clear();
    try { cacheStorage.delete(CACHE_KEY); } catch { /* optional cache */ }
}
