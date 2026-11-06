/** Lazy, event-driven Goal First view; cached metadata survives offline workers. */
import * as React from 'react';
import type { GoalBoardCatalogEntry, GoalBoardSnapshot, GoalTask } from '@slopus/happy-wire';
import { assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { useSession } from '@/sync/storage';
import { bindGoalBoard, getGoalTaskSessionId, loadGoalBoardCatalog, loadGoalBoardSnapshot, startGoalTaskSession } from '@/sync/goalBoard';
import { t } from '@/text';

const EMPTY_CATALOG: GoalBoardCatalogEntry[] = [];
function runtimeOwner(sessionId: string): string {
    const account = getRuntimeAccountSelection();
    return JSON.stringify([account?.key, account?.generation, sessionId]);
}
function explain(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : '';
    return /method.*not found|unknown.*method/i.test(message) ? t('goalBoard.unsupportedWorker') : message ? `${fallback}: ${message}` : fallback;
}

export function useGoalBoard(sessionId: string, enabled: boolean) {
    const session = useSession(sessionId);
    const featurePath = session?.metadata?.goalBoard?.featurePath ?? null;
    const offline = session?.presence !== 'online';
    const owner = runtimeOwner(sessionId);
    const [catalogState, setCatalog] = React.useState<{ owner: string; entries: GoalBoardCatalogEntry[] }>({ owner, entries: EMPTY_CATALOG });
    const catalog = catalogState.owner === owner ? catalogState.entries : EMPTY_CATALOG;
    const [remoteState, setRemote] = React.useState<{ owner: string; snapshot: GoalBoardSnapshot } | null>(null);
    const remote = remoteState?.owner === owner ? remoteState.snapshot : null;
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [openingTaskId, setOpeningTaskId] = React.useState<string | null>(null);
    const context = React.useRef({ sessionId, featurePath, offline, owner });
    const metadata = React.useRef(session?.metadata);
    metadata.current = session?.metadata;
    const alive = React.useRef(true);
    const generation = React.useRef(0);
    const viewGeneration = React.useRef(0);
    const catalogGeneration = React.useRef(0);
    const catalogLoaded = React.useRef(false);
    const catalogInFlight = React.useRef(false);
    const readFeatures = React.useRef(new Set<string>());
    const stableSnapshot = React.useRef<GoalBoardSnapshot | null>(null);
    if (context.current.owner !== owner || context.current.featurePath !== featurePath || context.current.offline !== offline) {
        viewGeneration.current += 1;
        generation.current += 1;
        readFeatures.current = new Set();
        if (context.current.owner !== owner || context.current.offline !== offline) {
            catalogGeneration.current += 1;
            catalogLoaded.current = false;
            catalogInFlight.current = false;
        }
        if (context.current.owner !== owner) stableSnapshot.current = null;
    }
    context.current = { sessionId, featurePath, offline, owner };
    React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; generation.current += 1; viewGeneration.current += 1; catalogGeneration.current += 1; };
    }, []);
    const owns = React.useCallback((requestedOwner: string) => {
        try { assertAccountRuntime(); } catch { return false; }
        return alive.current && context.current.owner === requestedOwner && runtimeOwner(context.current.sessionId) === requestedOwner;
    }, []);

    const read = React.useCallback(async (requestedFeature: string) => {
        const { owner, sessionId } = context.current;
        const request = ++generation.current;
        setLoading(true); setError(null);
        try {
            const snapshot = await loadGoalBoardSnapshot(sessionId, requestedFeature);
            if (!owns(owner) || request !== generation.current || context.current.featurePath !== requestedFeature) return;
            setRemote({ owner, snapshot });
        } catch (cause) {
            if (owns(owner) && request === generation.current && context.current.featurePath === requestedFeature) setError(explain(cause, t('goalBoard.refreshFailed')));
        } finally {
            if (owns(owner) && request === generation.current) setLoading(false);
        }
    }, [owns]);
    const readCatalog = React.useCallback(async () => {
        if (catalogLoaded.current || catalogInFlight.current || context.current.offline) return;
        const { owner, sessionId } = context.current;
        const request = ++catalogGeneration.current;
        catalogInFlight.current = true;
        if (!context.current.featurePath) setLoading(true);
        try {
            const entries = await loadGoalBoardCatalog(sessionId);
            if (!owns(owner) || catalogGeneration.current !== request) return;
            catalogLoaded.current = true;
            setCatalog({ owner, entries });
        } catch (cause) {
            if (owns(owner) && catalogGeneration.current === request) setError(explain(cause, t('goalBoard.refreshFailed')));
        } finally {
            if (owns(owner) && catalogGeneration.current === request) { catalogInFlight.current = false; if (!context.current.featurePath) setLoading(false); }
        }
    }, [owns]);
    React.useEffect(() => {
        setCatalog({ owner, entries: EMPTY_CATALOG }); setRemote(null); setLoading(false); setError(null); setOpeningTaskId(null);
    }, [owner]);
    React.useEffect(() => { setLoading(false); setError(null); setOpeningTaskId(null); }, [featurePath, offline]);
    React.useEffect(() => {
        if (!enabled || offline) return;
        void readCatalog();
        if (featurePath && !readFeatures.current.has(featurePath)) {
            // A failed attempt is still an attempt: no render-driven retry loop.
            readFeatures.current.add(featurePath);
            void read(featurePath);
        }
    }, [enabled, offline, owner, featurePath, read, readCatalog]);

    const cached = session?.metadata?.goalBoardSnapshot;
    const candidate = cached?.featurePath === featurePath && (!remote || remote.featurePath !== featurePath || cached.updatedAt >= remote.updatedAt)
        ? cached : remote?.featurePath === featurePath ? remote : null;
    if (!candidate) stableSnapshot.current = null;
    else if (stableSnapshot.current?.featurePath !== candidate.featurePath || stableSnapshot.current?.revision !== candidate.revision) stableSnapshot.current = candidate;

    const selectFeature = React.useCallback(async (entry: GoalBoardCatalogEntry): Promise<void> => {
        const { owner, sessionId } = context.current;
        if (!owns(owner) || context.current.offline) return;
        const request = ++generation.current;
        readFeatures.current.delete(entry.featurePath);
        setLoading(true); setError(null);
        try { await bindGoalBoard(sessionId, entry.featurePath); }
        catch (cause) { if (owns(owner) && generation.current === request) setError(explain(cause, t('goalBoard.linkFailed'))); }
        finally { if (owns(owner) && generation.current === request) setLoading(false); }
    }, [owns]);
    const refresh = React.useCallback(async (): Promise<void> => {
        if (context.current.offline) return;
        const path = context.current.featurePath;
        if (path) await read(path);
        else { catalogLoaded.current = false; await readCatalog(); }
    }, [read, readCatalog]);
    const openTask = React.useCallback(async (task: GoalTask, newSession: boolean): Promise<string> => {
        const { owner, sessionId, featurePath: path } = context.current;
        const view = viewGeneration.current;
        if (!owns(owner)) throw new Error('Goal board request context expired');
        if (!path || context.current.offline) throw new Error(t('goalBoard.offlineEmpty'));
        setOpeningTaskId(task.id);
        try {
            const childId = await startGoalTaskSession({ sessionId, featurePath: path, task, newSession });
            if (!owns(owner) || viewGeneration.current !== view || context.current.featurePath !== path) throw new Error('Goal board task context expired');
            return childId;
        } finally { if (owns(owner) && viewGeneration.current === view) setOpeningTaskId(null); }
    }, [owns]);
    const getTaskSessionId = React.useCallback((task: GoalTask): string | null => {
        const path = context.current.featurePath;
        return path && owns(context.current.owner) ? getGoalTaskSessionId(metadata.current, path, task.id) : null;
    }, [owns]);

    return { snapshot: stableSnapshot.current, catalog, loading, error, offline, openingTaskId,
        activeTaskId: session?.metadata?.goalBoard?.taskId, parentSessionId: session?.metadata?.goalBoard?.parentSessionId,
        selectFeature, refresh, openTask, getTaskSessionId };
}
