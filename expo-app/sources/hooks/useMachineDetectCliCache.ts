import * as React from 'react';
import { machineDetectCli, type DetectCliResponse } from '@/sync/ops';

export type MachineDetectCliCacheState =
    | { status: 'idle' }
    | { status: 'loading'; response?: DetectCliResponse }
    | { status: 'loaded'; response: DetectCliResponse }
    | { status: 'not-supported' }
    | { status: 'error' };

type CacheEntry =
    | {
        state: MachineDetectCliCacheState;
        updatedAt: number;
        inFlight?: Promise<void>;
    };

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<(state: MachineDetectCliCacheState) => void>>();

const DEFAULT_STALE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_FETCH_TIMEOUT_MS = 2500;

function getEntry(cacheKey: string): CacheEntry | null {
    return cache.get(cacheKey) ?? null;
}

function notify(cacheKey: string) {
    const entry = getEntry(cacheKey);
    if (!entry) return;
    const subs = listeners.get(cacheKey);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) cb(entry.state);
}

function setEntry(cacheKey: string, entry: CacheEntry) {
    cache.set(cacheKey, entry);
    notify(cacheKey);
}

function subscribe(cacheKey: string, cb: (state: MachineDetectCliCacheState) => void): () => void {
    let set = listeners.get(cacheKey);
    if (!set) {
        set = new Set();
        listeners.set(cacheKey, set);
    }
    set.add(cb);
    return () => {
        const current = listeners.get(cacheKey);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) listeners.delete(cacheKey);
    };
}

async function fetchAndCache(params: { machineId: string; includeLoginStatus: boolean }): Promise<void> {
    const cacheKey = `${params.machineId}:${params.includeLoginStatus ? 'login' : 'basic'}`;
    const existing = getEntry(cacheKey);
    if (existing?.inFlight) {
        return existing.inFlight;
    }

    const prevResponse =
        existing?.state.status === 'loaded'
            ? existing.state.response
            : existing?.state.status === 'loading'
                ? existing.state.response
                : undefined;

    // Create the in-flight promise first, then store it in cache (avoid TDZ/self-reference bugs).
    const inFlight = (async () => {
        try {
            const result = await Promise.race([
                machineDetectCli(params.machineId, params.includeLoginStatus ? { includeLoginStatus: true } : undefined),
                new Promise<{ supported: false; reason: 'error' }>((resolve) => {
                    // Old daemons can hang on unknown RPCs; don't let the UI get stuck in "loading".
                    setTimeout(() => resolve({ supported: false, reason: 'error' }), DEFAULT_FETCH_TIMEOUT_MS);
                }),
            ]);
            if (result.supported) {
                setEntry(cacheKey, { state: { status: 'loaded', response: result.response }, updatedAt: Date.now() });
            } else {
                setEntry(cacheKey, {
                    state: result.reason === 'not-supported' ? { status: 'not-supported' } : { status: 'error' },
                    updatedAt: Date.now(),
                });
            }
        } catch {
            setEntry(cacheKey, { state: { status: 'error' }, updatedAt: Date.now() });
        } finally {
            const current = getEntry(cacheKey);
            if (current?.inFlight) {
                // Clear inFlight marker so future refreshes can run.
                setEntry(cacheKey, { state: current.state, updatedAt: current.updatedAt });
            }
        }
    })();

    // Mark as loading immediately (stale-while-revalidate: keep prior response if available).
    setEntry(cacheKey, {
        state: { status: 'loading', ...(prevResponse ? { response: prevResponse } : {}) },
        updatedAt: Date.now(),
        inFlight,
    });

    return inFlight;
}

/**
 * Prefetch detect-cli data into the UI cache.
 *
 * Intended for cases like the New Session wizard where we want to populate glyphs
 * once on screen open, without triggering per-row auto-detect work during taps.
 */
export function prefetchMachineDetectCli(params: { machineId: string; includeLoginStatus?: boolean }): Promise<void> {
    return fetchAndCache({ machineId: params.machineId, includeLoginStatus: Boolean(params.includeLoginStatus) });
}

/**
 * Prefetch detect-cli data only if missing (no cache entry yet).
 *
 * This matches the "detect once, then only refresh on explicit user action" rule.
 */
export function prefetchMachineDetectCliIfMissing(params: { machineId: string; includeLoginStatus?: boolean }): Promise<void> {
    const cacheKey = `${params.machineId}:${params.includeLoginStatus ? 'login' : 'basic'}`;
    const existing = getEntry(cacheKey);
    if (!existing) {
        return fetchAndCache({ machineId: params.machineId, includeLoginStatus: Boolean(params.includeLoginStatus) });
    }
    if (existing.state.status === 'idle') {
        return fetchAndCache({ machineId: params.machineId, includeLoginStatus: Boolean(params.includeLoginStatus) });
    }
    // If we already have data (or even an error), do not auto-refetch.
    return Promise.resolve();
}

/**
 * Prefetch detect-cli data only if missing or stale.
 *
 * Intended for screen-open "background refresh" where we want to pick up
 * newly-installed CLIs, but avoid fetches on every tap/navigation.
 */
export function prefetchMachineDetectCliIfStale(params: {
    machineId: string;
    staleMs: number;
    includeLoginStatus?: boolean;
}): Promise<void> {
    const cacheKey = `${params.machineId}:${params.includeLoginStatus ? 'login' : 'basic'}`;
    const existing = getEntry(cacheKey);
    if (!existing || existing.state.status === 'idle') {
        return fetchAndCache({ machineId: params.machineId, includeLoginStatus: Boolean(params.includeLoginStatus) });
    }
    const now = Date.now();
    const isStale = (now - existing.updatedAt) > params.staleMs;
    if (isStale) {
        return fetchAndCache({ machineId: params.machineId, includeLoginStatus: Boolean(params.includeLoginStatus) });
    }
    return Promise.resolve();
}

/**
 * UI-level cached wrapper around the daemon `detect-cli` RPC.
 *
 * - Per-machine cache with TTL
 * - "Stale while revalidate" behavior (keeps last response while loading)
 * - Caller controls whether fetching is enabled (e.g. only for online machines)
 */
export function useMachineDetectCliCache(params: {
    machineId: string | null;
    enabled: boolean;
    staleMs?: number;
    includeLoginStatus?: boolean;
}): { state: MachineDetectCliCacheState; refresh: () => void } {
    const { machineId, enabled, staleMs = DEFAULT_STALE_MS, includeLoginStatus = false } = params;
    const cacheKey = machineId ? `${machineId}:${includeLoginStatus ? 'login' : 'basic'}` : null;

    const [state, setState] = React.useState<MachineDetectCliCacheState>(() => {
        if (!cacheKey) return { status: 'idle' };
        const entry = getEntry(cacheKey);
        return entry?.state ?? { status: 'idle' };
    });

    const refresh = React.useCallback(() => {
        if (!machineId) return;
        // Update local state immediately (e.g. to show loading UI) since fetchAndCache
        // synchronously sets the cache entry to { status: 'loading', ... }.
        void fetchAndCache({ machineId, includeLoginStatus });
        const next = cacheKey ? getEntry(cacheKey) : null;
        if (next) setState(next.state);
        const inFlight = next?.inFlight;
        if (inFlight) {
            void inFlight.finally(() => {
                const entry = cacheKey ? getEntry(cacheKey) : null;
                if (entry) setState(entry.state);
            });
        }
    }, [cacheKey, includeLoginStatus, machineId]);

    React.useEffect(() => {
        if (!cacheKey) {
            setState({ status: 'idle' });
            return;
        }

        const unsubscribe = subscribe(cacheKey, (nextState) => {
            setState(nextState);
        });

        const entry = getEntry(cacheKey);
        if (entry) {
            setState(entry.state);
        }

        if (!enabled) {
            return unsubscribe;
        }

        const now = Date.now();
        const shouldFetch = !entry || (now - entry.updatedAt) > staleMs;
        if (!shouldFetch) {
            return unsubscribe;
        }

        refresh();
        return unsubscribe;
    }, [cacheKey, enabled, refresh, staleMs]);

    return { state, refresh };
}

