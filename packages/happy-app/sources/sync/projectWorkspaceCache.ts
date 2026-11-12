import { z } from 'zod';
import { GoalProjectSchema, GoalBoardSnapshotSchema, GoalTaskSessionSchema } from '@slopus/happy-wire';
import { accountRuntimeCurrent, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { configureProjectSessionDeletionPersistence, isProjectSessionDeleted, markProjectSessionDeleted } from './projectSessionLinks';
export { isProjectSessionDeleted, subscribeProjectSessionDeletions, getProjectSessionDeletionRevision } from './projectSessionLinks';
import { loadProjectWorkspaceCache, saveProjectWorkspaceCache, loadProjectSessionDeleted, saveProjectSessionDeleted } from './persistence';

configureProjectSessionDeletionPersistence({
    has: key => accountRuntimeCurrent() && loadProjectSessionDeleted(key),
    mark: key => { if (accountRuntimeCurrent()) saveProjectSessionDeleted(key); },
});

export const projectCatalogSchema = z.array(GoalProjectSchema).max(1000);
export const projectBoardSchema = z.object({ snapshot: GoalBoardSnapshotSchema, sessions: z.record(z.string(), z.array(GoalTaskSessionSchema).max(1000)) });
export const projectHistorySchema = z.object({ sessions: z.array(GoalTaskSessionSchema).max(1000), nextCursor: z.object({ sessionId: z.string(), updatedAt: z.number() }).optional() });
const entriesSchema = z.array(z.object({ key: z.string(), savedAt: z.number(), revision: z.string().optional(), value: z.unknown() })).max(40);
const maxAge = 7 * 24 * 60 * 60 * 1000;
const maxCharacters = 1024 * 1024;
/** Called only by the existing authoritative deletion/404 path, never by list absence. */
export function removeProjectSessionFromCache(sessionId: string) {
    if (!accountRuntimeCurrent()) return;
    try {
        const next = entries().map(entry => {
            const history = projectHistorySchema.safeParse(entry.value);
            return history.success ? { ...entry, value: { ...history.data, sessions: history.data.sessions.filter(session => session.sessionId !== sessionId) } } : entry;
        });
        saveProjectWorkspaceCache(JSON.stringify(next));
    } catch { /* Cache eviction cannot interrupt authoritative session deletion. */ }
    markProjectSessionDeleted(sessionId);
}

export function projectCacheKey(kind: 'catalog' | 'board' | 'history' | 'overview', machineId: string, featurePath?: string, taskId?: string) {
    const account = getRuntimeAccountSelection();
    const preview = (globalThis as typeof globalThis & { __HAPPY_CONFIG__?: { goalProjectReadOnly?: boolean } }).__HAPPY_CONFIG__?.goalProjectReadOnly === true;
    // Generation fences in-flight work; stable account/server/scope survive reloads.
    return JSON.stringify([account?.key, account?.scope, account?.serverUrl, preview, machineId, kind, featurePath, taskId]);
}
function entries() {
    try {
        if (!accountRuntimeCurrent()) return [];
        const raw = loadProjectWorkspaceCache();
        if (!raw || raw.length > maxCharacters) return [];
        return entriesSchema.parse(JSON.parse(raw)).filter(entry => entry.savedAt <= Date.now() && Date.now() - entry.savedAt < maxAge);
    } catch { return []; }
}
export function readProjectCache<T>(key: string, schema: z.ZodType<T>): { value: T; savedAt: number; revision?: string } | null {
    const entry = entries().find(entry => entry.key === key);
    if (!entry) return null;
    const parsed = schema.safeParse(entry.value);
    return parsed.success ? { value: parsed.data, savedAt: entry.savedAt, revision: entry.revision } : null;
}
export function writeProjectCache<T>(key: string, value: T, revision?: string) {
    if (!accountRuntimeCurrent()) return;
    try {
        const history = projectHistorySchema.safeParse(value);
        if (history.success) value = { ...history.data, sessions: history.data.sessions.filter(session => !isProjectSessionDeleted(session.sessionId)) } as T;
        const next = [...entries().filter(entry => entry.key !== key), { key, value, revision, savedAt: Date.now() }].slice(-40);
        let serialized = JSON.stringify(next);
        while (next.length && serialized.length > maxCharacters) { next.shift(); serialized = JSON.stringify(next); }
        saveProjectWorkspaceCache(serialized);
    } catch { /* Storage quota/private mode must not turn a successful RPC into a failed read. */ }
}
