/** Typed Goal First RPC, durable association, and idempotent task-session launch. */
import { z } from 'zod';
import { GoalBoardCatalogEntrySchema, GoalBoardSnapshotSchema, type GoalBoardCatalogEntry, type GoalBoardSnapshot, type GoalTask } from '@slopus/happy-wire';
import { assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { AsyncLock } from '@/utils/lock';
import { apiSocket } from './apiSocket';
import { storage } from './storage';
import type { Metadata } from './storageTypes';
import { sessionUpdateMetadata, machineStartGoalTask } from './ops';
import { ensureSessionHydratedWithRetry } from './ensureSessionHydratedWithRetry';

const errorResponse = z.object({ success: z.literal(false), error: z.string() });
const catalogResponse = z.union([errorResponse, z.object({ success: z.literal(true), goals: z.array(GoalBoardCatalogEntrySchema).max(1000) })]);
const boardResponse = z.union([errorResponse, z.object({ success: z.literal(true), snapshot: GoalBoardSnapshotSchema })]);
const launchResponse = z.object({ success: z.boolean(), sessionId: z.string().optional(), title: z.string().optional(), error: z.string().optional() });
const metadataLocks = new Map<string, { lock: AsyncLock; users: number }>();
type LaunchRecord = { requestId: string; promise?: Promise<string>; sessionId?: string; confirmed?: boolean };
const launches = new Map<string, LaunchRecord>();
let requestEpoch = 0;
let cacheAccount: string | null = null;

function accountIdentity(): string {
    assertAccountRuntime();
    const account = getRuntimeAccountSelection();
    return JSON.stringify([account?.key, account?.generation, account?.serverUrl]);
}
function captureOwner(): string {
    const account = accountIdentity();
    if (cacheAccount !== account) {
        clearGoalBoardRequestCache();
        cacheAccount = account;
    }
    return JSON.stringify([account, requestEpoch]);
}
function assertOwner(owner: string): void {
    if (owner !== JSON.stringify([accountIdentity(), requestEpoch])) throw new Error('Goal board request context expired');
}

/** JSON tuple encoding avoids collisions from path separators, Unicode, or task ids. */
export function goalTaskSessionKey(featurePath: string, taskId: string): string {
    return JSON.stringify([featurePath, taskId]);
}
export function getGoalTaskSessionId(metadata: Metadata | null | undefined, featurePath: string, taskId: string): string | null {
    const map = metadata?.goalBoardTaskSessions;
    const read = (key: string) => map && Object.prototype.hasOwnProperty.call(map, key) && typeof map[key] === 'string' ? map[key] : null;
    return read(goalTaskSessionKey(featurePath, taskId))
        ?? (metadata?.goalBoard?.featurePath === featurePath ? read(taskId) : null);
}
function scopedTaskSessions(metadata: Metadata): Record<string, string> {
    const entries = Object.entries(metadata.goalBoardTaskSessions ?? {});
    const featurePath = metadata.goalBoard?.featurePath;
    return Object.fromEntries(entries.map(([key, sessionId]) => {
        let scoped = false;
        try { const value: unknown = JSON.parse(key); scoped = Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string'); } catch { /* Legacy plain task id. */ }
        return [!scoped && featurePath ? goalTaskSessionKey(featurePath, key) : key, sessionId];
    }));
}

function rpcError(response: unknown): void {
    if (response && typeof response === 'object' && 'error' in response && typeof response.error === 'string') throw new Error(response.error);
}

export async function loadGoalBoardCatalog(sessionId: string): Promise<GoalBoardCatalogEntry[]> {
    const owner = captureOwner();
    const response: unknown = await apiSocket.sessionRPC(sessionId, 'goalBoardCatalog', {});
    assertOwner(owner);
    rpcError(response);
    const parsed = catalogResponse.parse(response);
    if (!parsed.success) throw new Error(parsed.error);
    return parsed.goals;
}

export async function loadGoalBoardSnapshot(sessionId: string, featurePath: string): Promise<GoalBoardSnapshot> {
    const owner = captureOwner();
    const response: unknown = await apiSocket.sessionRPC(sessionId, 'goalBoardRead', { featurePath });
    assertOwner(owner);
    rpcError(response);
    const parsed = boardResponse.parse(response);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.snapshot.featurePath !== featurePath) throw new Error('Goal board returned a different feature');
    return parsed.snapshot;
}

async function updateMetadata(sessionId: string, updater: (metadata: Metadata) => Metadata, owner = captureOwner()): Promise<void> {
    assertOwner(owner);
    const key = JSON.stringify([owner, sessionId]);
    let entry = metadataLocks.get(key);
    if (!entry) { entry = { lock: new AsyncLock(), users: 0 }; metadataLocks.set(key, entry); }
    entry.users += 1;
    try {
        await entry.lock.inLock(async () => {
            assertOwner(owner);
            const session = storage.getState().sessions[sessionId];
            if (!session?.metadata) throw new Error('Session metadata is unavailable');
            const result = await sessionUpdateMetadata(sessionId, session.metadata, session.metadataVersion, metadata => {
                assertOwner(owner);
                return updater(metadata);
            });
            assertOwner(owner);
            const current = storage.getState().sessions[sessionId];
            if (!current) throw new Error('Session is no longer available');
            if (current.metadataVersion > result.version) return;
            storage.getState().applySessions([{ ...current, metadata: result.metadata, metadataVersion: result.version }]);
        });
        assertOwner(owner);
    } finally {
        entry.users -= 1;
        if (!entry.users && metadataLocks.get(key) === entry) metadataLocks.delete(key);
    }
}

export async function bindGoalBoard(sessionId: string, featurePath: string): Promise<void> {
    await updateMetadata(sessionId, current => current.goalBoard?.featurePath === featurePath ? current : ({
        ...current,
        goalBoard: { featurePath, ...(current.goalBoard?.parentSessionId ? { parentSessionId: current.goalBoard.parentSessionId } : {}) },
        goalBoardTaskSessions: scopedTaskSessions(current),
        goalBoardSnapshot: undefined,
    }));
}

export async function startGoalTaskSession(options: { sessionId: string; featurePath: string; task: GoalTask; newSession?: boolean }): Promise<string> {
    const { sessionId, featurePath, task, newSession = false } = options;
    const owner = captureOwner();
    const scope = JSON.stringify([owner, sessionId]);
    const assertBound = () => {
        assertOwner(owner);
        if (storage.getState().sessions[sessionId]?.metadata?.goalBoard?.featurePath !== featurePath) throw new Error('Goal board feature binding changed');
    };
    assertBound();
    const parent = storage.getState().sessions[sessionId];
    const linked = getGoalTaskSessionId(parent?.metadata, featurePath, task.id);
    if (!newSession && linked) {
        if (!await ensureSessionHydratedWithRetry(linked)) throw new Error('Task session could not be loaded');
        assertBound();
        return linked;
    }
    const key = JSON.stringify([scope, featurePath, task.id, newSession]);
    const existing = launches.get(key);
    if (existing?.promise) return existing.promise;
    // Confirmed entries remain until both metadata associations are durable. Failed
    // sends retain requestId so the daemon reuses its partially-created child.
    // Even confirmed entries may still need hydration/metadata repair. Evicting
    // one would lose its request id and create a second child on the next retry.
    if (!existing && launches.size >= 256) throw new Error('Too many pending task sessions');
    const record: LaunchRecord = existing ?? { requestId: `goal-task-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    launches.set(key, record);
    const operation = (async () => {
        if (!record.confirmed) {
            const metadata = storage.getState().sessions[sessionId]?.metadata;
            if (!metadata?.machineId || !['codex', 'claude'].includes(metadata.flavor ?? '') || metadata.application || metadata.sandbox?.enabled) throw new Error('Task session launch is unavailable for this session');
            const response = await machineStartGoalTask(metadata.machineId, {
                featurePath, taskId: task.id, requestId: record.requestId,
                action: newSession ? 'chat' : 'execute', agent: metadata.flavor === 'codex' ? 'codex' : 'claude',
            });
            assertBound();
            const result = launchResponse.parse(response.type === 'success' ? { success: true, sessionId: response.sessionId } : { success: false, error: response.type === 'error' ? response.errorMessage : 'Task directory is unavailable' });
            if (result.sessionId) record.sessionId = result.sessionId;
            if (!result.success || !result.sessionId) throw new Error(result.error || 'Task session could not be started');
            record.confirmed = true;
        }
        const childId = record.sessionId!;
        if (!await ensureSessionHydratedWithRetry(childId)) throw new Error('Task session was created but could not be loaded');
        assertBound();
        await updateMetadata(childId, current => { assertBound(); return { ...current, goalBoard: { featurePath, taskId: task.id, parentSessionId: sessionId } }; }, owner);
        assertBound();
        await updateMetadata(sessionId, current => {
            assertBound();
            if (current.goalBoard?.featurePath !== featurePath) throw new Error('Goal board feature binding changed');
            return { ...current, goalBoardTaskSessions: { ...scopedTaskSessions(current), [goalTaskSessionKey(featurePath, task.id)]: childId } };
        }, owner);
        assertBound();
        if (launches.get(key) === record) launches.delete(key);
        return childId;
    })();
    record.promise = operation;
    try { return await operation; } finally { record.promise = undefined; }
}

/** Account/logout and test boundaries discard local pending-operation ownership. */
export function clearGoalBoardRequestCache(): void {
    requestEpoch += 1;
    launches.clear();
    metadataLocks.clear();
}
