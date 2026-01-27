import * as React from 'react';
import {
    machineCapabilitiesDetect,
    type MachineCapabilitiesDetectResult,
} from '@/sync/ops';
import type { CapabilitiesDetectRequest, CapabilitiesDetectResponse, CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';
import { CHECKLIST_IDS, resumeChecklistId } from '@happy/protocol/checklists';
import { AGENT_IDS } from '@/agents/catalog';

export type MachineCapabilitiesSnapshot = {
    response: CapabilitiesDetectResponse;
};

export type MachineCapabilitiesCacheState =
    | { status: 'idle' }
    | { status: 'loading'; snapshot?: MachineCapabilitiesSnapshot }
    | { status: 'loaded'; snapshot: MachineCapabilitiesSnapshot }
    | { status: 'not-supported' }
    | { status: 'error'; snapshot?: MachineCapabilitiesSnapshot };

type CacheEntry = {
    state: MachineCapabilitiesCacheState;
    updatedAt: number;
    inFlightToken?: number;
};

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<(state: MachineCapabilitiesCacheState) => void>>();

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_FETCH_TIMEOUT_MS = 2500;

function getEntry(cacheKey: string): CacheEntry | null {
    return cache.get(cacheKey) ?? null;
}

export function getMachineCapabilitiesCacheState(machineId: string): MachineCapabilitiesCacheState | null {
    const entry = getEntry(machineId);
    return entry ? entry.state : null;
}

export function getMachineCapabilitiesSnapshot(machineId: string): MachineCapabilitiesSnapshot | null {
    const state = getMachineCapabilitiesCacheState(machineId);
    if (!state) return null;
    if (state.status === 'loaded') return state.snapshot;
    if (state.status === 'loading') return state.snapshot ?? null;
    if (state.status === 'error') return state.snapshot ?? null;
    return null;
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

function subscribe(cacheKey: string, cb: (state: MachineCapabilitiesCacheState) => void): () => void {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeCapabilityResult(id: CapabilityId, prev: CapabilityDetectResult | undefined, next: CapabilityDetectResult): CapabilityDetectResult {
    if (!prev) return next;
    if (!prev.ok || !next.ok) return next;

    // Only merge partial results for deps; CLI/tool checks should replace to avoid keeping stale paths/versions.
    if (!id.startsWith('dep.')) return next;
    if (!isPlainObject(prev.data) || !isPlainObject(next.data)) return next;

    return { ...next, data: { ...prev.data, ...next.data } };
}

function mergeDetectResponses(prev: CapabilitiesDetectResponse | null, next: CapabilitiesDetectResponse): CapabilitiesDetectResponse {
    if (!prev) return next;
    const merged: Partial<Record<CapabilityId, CapabilityDetectResult>> = { ...prev.results };
    for (const [id, result] of Object.entries(next.results) as Array<[CapabilityId, CapabilityDetectResult]>) {
        merged[id] = mergeCapabilityResult(id, merged[id], result);
    }
    return {
        protocolVersion: 1,
        results: merged,
    };
}

function getTimeoutMsForRequest(request: CapabilitiesDetectRequest, fallback: number): number {
    // Default fast timeout; opt into longer waits for npm registry checks.
    const requests = Array.isArray(request.requests) ? request.requests : [];
    const hasRegistryCheck = requests.some((r) => Boolean((r.params as any)?.includeRegistry));
    const isResumeChecklist = AGENT_IDS.some((agentId) => request.checklistId === resumeChecklistId(agentId));
    const isMachineDetailsChecklist = request.checklistId === CHECKLIST_IDS.MACHINE_DETAILS;
    if (hasRegistryCheck || isResumeChecklist) return Math.max(fallback, 12_000);
    if (isMachineDetailsChecklist) return Math.max(fallback, 8_000);
    return fallback;
}

async function fetchAndMerge(params: {
    machineId: string;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    const cacheKey = params.machineId;
    const token = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    const existing = getEntry(cacheKey);
    const prevSnapshot =
        existing?.state.status === 'loaded'
            ? existing.state.snapshot
            : existing?.state.status === 'loading'
                ? existing.state.snapshot
                : existing?.state.status === 'error'
                    ? existing.state.snapshot
                    : undefined;

    setEntry(cacheKey, {
        state: { status: 'loading', ...(prevSnapshot ? { snapshot: prevSnapshot } : {}) },
        updatedAt: Date.now(),
        inFlightToken: token,
    });

    const timeoutMs = typeof params.timeoutMs === 'number'
        ? params.timeoutMs
        : getTimeoutMsForRequest(params.request, DEFAULT_FETCH_TIMEOUT_MS);

    let result: MachineCapabilitiesDetectResult;
    try {
        result = await machineCapabilitiesDetect(params.machineId, params.request, { timeoutMs });
    } catch {
        const current = getEntry(cacheKey);
        if (!current || current.inFlightToken !== token) {
            return;
        }

        setEntry(cacheKey, {
            state: prevSnapshot ? ({ status: 'error', snapshot: prevSnapshot } as const) : ({ status: 'error' } as const),
            updatedAt: Date.now(),
        });
        return;
    }

    const current = getEntry(cacheKey);
    if (!current || current.inFlightToken !== token) {
        return;
    }
    const baseResponse = prevSnapshot?.response ?? null;

    const nextState = (() => {
        if (result.supported) {
            const merged = mergeDetectResponses(baseResponse, result.response);
            const snapshot: MachineCapabilitiesSnapshot = { response: merged };
            const stillInFlight = current?.inFlightToken !== token && typeof current?.inFlightToken === 'number';
            return stillInFlight
                ? ({ status: 'loading', snapshot } as const)
                : ({ status: 'loaded', snapshot } as const);
        }

        if (result.reason === 'not-supported') {
            return { status: 'not-supported' } as const;
        }

        return prevSnapshot
            ? ({ status: 'error', snapshot: prevSnapshot } as const)
            : ({ status: 'error' } as const);
    })();

    setEntry(cacheKey, {
        state: nextState,
        updatedAt: Date.now(),
    });
}

export function prefetchMachineCapabilities(params: {
    machineId: string;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    return fetchAndMerge(params);
}

export function prefetchMachineCapabilitiesIfStale(params: {
    machineId: string;
    staleMs: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    const cacheKey = params.machineId;
    const existing = getEntry(cacheKey);
    if (!existing || existing.state.status === 'idle') {
        return fetchAndMerge({ machineId: params.machineId, request: params.request, timeoutMs: params.timeoutMs });
    }
    const now = Date.now();
    const isStale = (now - existing.updatedAt) > params.staleMs;
    if (isStale) {
        return fetchAndMerge({ machineId: params.machineId, request: params.request, timeoutMs: params.timeoutMs });
    }
    return Promise.resolve();
}

export function useMachineCapabilitiesCache(params: {
    machineId: string | null;
    enabled: boolean;
    staleMs?: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): { state: MachineCapabilitiesCacheState; refresh: (next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number }) => void } {
    const { machineId, enabled, staleMs = DEFAULT_STALE_MS } = params;
    const cacheKey = machineId ?? null;

    // Keep the refresh function referentially stable even when callers pass a new request
    // object each render. This prevents effect churn (and, in extreme cases, navigation
    // setOptions loops) while still ensuring refresh uses the latest request/timeout.
    const requestRef = React.useRef<CapabilitiesDetectRequest>(params.request);
    requestRef.current = params.request;
    const timeoutMsRef = React.useRef<number | undefined>(params.timeoutMs);
    timeoutMsRef.current = params.timeoutMs;

    const [state, setState] = React.useState<MachineCapabilitiesCacheState>(() => {
        if (!cacheKey) return { status: 'idle' };
        const entry = getEntry(cacheKey);
        return entry?.state ?? { status: 'idle' };
    });

    const refresh = React.useCallback((next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number }) => {
        if (!machineId) return;
        void fetchAndMerge({
            machineId,
            request: next?.request ?? requestRef.current,
            timeoutMs: typeof next?.timeoutMs === 'number' ? next.timeoutMs : timeoutMsRef.current,
        });
        const entry = getEntry(machineId);
        if (entry) setState(entry.state);
    }, [machineId]);

    React.useEffect(() => {
        if (!cacheKey) {
            setState({ status: 'idle' });
            return;
        }

        const unsubscribe = subscribe(cacheKey, (nextState) => setState(nextState));

        const entry = getEntry(cacheKey);
        if (entry) setState(entry.state);

        if (!enabled) {
            return unsubscribe;
        }

        const now = Date.now();
        const shouldFetch = !entry || (now - entry.updatedAt) > staleMs;
        if (shouldFetch) {
            refresh();
        }

        return unsubscribe;
    }, [cacheKey, enabled, refresh, staleMs]);

    return { state, refresh };
}
