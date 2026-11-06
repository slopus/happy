import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetadataSchema } from './storageTypes';
import type { GoalTask } from '@slopus/happy-wire';

const state = vi.hoisted(() => ({ sessions: {} as Record<string, any>, applySessions: vi.fn(), rpc: vi.fn(), update: vi.fn(), hydrate: vi.fn(), account: { key: 'account', generation: 'generation' } }));
vi.mock('./storage', () => ({ storage: { getState: () => state } }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: state.rpc } }));
vi.mock('./ops', () => ({ sessionUpdateMetadata: state.update, SESSION_START_RPC_TIMEOUT_MS: 140000 }));
vi.mock('./ensureSessionHydratedWithRetry', () => ({ ensureSessionHydratedWithRetry: state.hydrate }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: vi.fn(), getRuntimeAccountSelection: () => state.account }));
import { bindGoalBoard, clearGoalBoardRequestCache, getGoalTaskSessionId, loadGoalBoardCatalog, loadGoalBoardSnapshot, startGoalTaskSession } from './goalBoard';

const task: GoalTask = { id: 'task-1', title: 'Task', status: 'running', indexPath: '/goals/feature/tasks/1/index.md', goal: 'Deliver a result', dependencies: [], expectedDeliverables: [], artifacts: [] };
const parent = () => ({ id: 'parent', metadataVersion: 1, metadata: { path: '/workspace', host: 'machine', machineId: 'machine', flavor: 'codex', goalBoard: { featurePath: '/goals/feature' } } });
const snapshot = { featurePath: '/goals/feature', title: 'Goal', revision: 'v1', updatedAt: 1, tasks: [task], warnings: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const sessionKey = (featurePath: string, taskId: string) => JSON.stringify([featurePath, taskId]);

beforeEach(() => {
    vi.clearAllMocks(); clearGoalBoardRequestCache();
    state.account = { key: 'account', generation: 'generation' };
    state.sessions = { parent: parent() };
    state.applySessions.mockImplementation((sessions: any[]) => sessions.forEach(s => { state.sessions[s.id] = s; }));
    state.update.mockImplementation(async (_id, metadata, version, update) => ({ metadata: update(metadata), version: version + 1 }));
    state.hydrate.mockResolvedValue(true);
});

describe('Goal First board metadata', () => {
    it('retains binding, task-session map and validated snapshot through metadata decoding', () => {
        const parsed = MetadataSchema.parse({ ...parent().metadata, goalBoardSnapshot: snapshot, goalBoardTaskSessions: { 'task-1': 'child' } });
        expect(parsed).toMatchObject({ goalBoard: { featurePath: '/goals/feature' }, goalBoardSnapshot: { revision: 'v1' }, goalBoardTaskSessions: { 'task-1': 'child' } });
    });
    it('persists a new association without losing unrelated metadata or keeping the old snapshot', async () => {
        state.sessions.parent.metadata.goalBoardSnapshot = snapshot;
        await bindGoalBoard('parent', '/goals/another');
        expect(state.sessions.parent.metadata).toMatchObject({ path: '/workspace', flavor: 'codex', goalBoard: { featurePath: '/goals/another' } });
        expect(state.sessions.parent.metadata.goalBoardSnapshot).toBeUndefined();
        expect(state.rpc).not.toHaveBeenCalled();
    });
    it('does not treat inherited object properties as linked legacy sessions', () => {
        state.sessions.parent.metadata.goalBoardTaskSessions = {};
        expect(getGoalTaskSessionId(state.sessions.parent.metadata, '/goals/feature', 'constructor')).toBeNull();
    });
    it('serializes concurrent metadata writes without discarding the later binding', async () => {
        const first = deferred<any>();
        state.update.mockImplementationOnce((_id, metadata, version, update) => first.promise.then(() => ({ metadata: update(metadata), version: version + 1 })));
        const a = bindGoalBoard('parent', '/goals/a');
        const b = bindGoalBoard('parent', '/goals/b');
        await Promise.resolve(); await Promise.resolve();
        expect(state.update).toHaveBeenCalledTimes(1);
        first.resolve(undefined);
        await Promise.all([a, b]);
        expect(state.sessions.parent.metadataVersion).toBe(3);
        expect(state.sessions.parent.metadata.goalBoard.featurePath).toBe('/goals/b');
    });
});

describe('Goal board RPC reads', () => {
    it('rejects malformed snapshots instead of presenting them as task data', async () => {
        state.rpc.mockResolvedValue({ success: true, snapshot: { tasks: 'invalid' } });
        await expect(loadGoalBoardSnapshot('parent', '/goals/feature')).rejects.toThrow();
    });
    it('loads the catalog through one typed RPC and reports unsupported workers', async () => {
        state.rpc.mockResolvedValueOnce({ success: true, goals: [{ featurePath: '/goals/feature', title: 'Goal' }] });
        expect(await loadGoalBoardCatalog('parent')).toHaveLength(1);
        expect(state.rpc).toHaveBeenCalledWith('parent', 'goalBoardCatalog', {});
        state.rpc.mockResolvedValueOnce({ error: 'Method not found' });
        await expect(loadGoalBoardCatalog('parent')).rejects.toThrow('Method not found');
    });
    it.each(['catalog', 'snapshot'])('rejects a late %s response after its captured account changes', async (kind) => {
        const response = deferred<unknown>(); state.rpc.mockReturnValue(response.promise);
        const operation = kind === 'catalog' ? loadGoalBoardCatalog('parent') : loadGoalBoardSnapshot('parent', '/goals/feature');
        state.account = { key: 'other-account', generation: 'other-generation' };
        response.resolve(kind === 'catalog' ? { success: true, goals: [] } : { success: true, snapshot });
        await expect(operation).rejects.toThrow(/expired|changed/i);
    });
    it('does not apply a completed metadata write to another account with the same session id', async () => {
        const update = deferred<any>(); state.update.mockReturnValueOnce(update.promise);
        const operation = bindGoalBoard('parent', '/goals/another');
        await Promise.resolve(); await Promise.resolve();
        state.account = { key: 'other-account', generation: 'other-generation' };
        update.resolve({ metadata: { ...parent().metadata, goalBoard: { featurePath: '/goals/another' } }, version: 2 });
        await expect(operation).rejects.toThrow(/expired|changed/i);
        expect(state.applySessions).not.toHaveBeenCalled();
    });
});

describe('Task session startup', () => {
    it('shares a single launch across repeated clicks and associates both sessions after hydration', async () => {
        state.rpc.mockImplementation(async () => { state.sessions.child = { id: 'child', metadataVersion: 1, metadata: { path: '/goals/feature', host: 'machine' } }; return { success: true, sessionId: 'child', title: 'Task' }; });
        const args = { sessionId: 'parent', featurePath: '/goals/feature', task };
        expect(await Promise.all([startGoalTaskSession(args), startGoalTaskSession(args)])).toEqual(['child', 'child']);
        expect(state.rpc).toHaveBeenCalledTimes(1);
        expect(state.rpc.mock.calls[0][1]).toBe('goalBoardStartTask');
        expect(state.sessions.parent.metadata.goalBoardTaskSessions).toEqual({ [sessionKey('/goals/feature', 'task-1')]: 'child' });
        expect(state.sessions.child.metadata.goalBoard).toMatchObject({ featurePath: '/goals/feature', taskId: 'task-1', parentSessionId: 'parent' });
    });
    it('continues an existing linked session without spawning a replacement', async () => {
        state.sessions.parent.metadata.goalBoardTaskSessions = { 'task-1': 'existing' };
        expect(await startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task })).toBe('existing');
        expect(state.rpc).not.toHaveBeenCalled();
    });
    it('keeps identical task ids in different features associated with their own child sessions', async () => {
        state.sessions.parent.metadata.goalBoardTaskSessions = { [sessionKey('/goals/previous', task.id)]: 'old-child' };
        state.rpc.mockImplementation(async () => { state.sessions.child = { id: 'child', metadataVersion: 1, metadata: { path: '/goals/feature', host: 'machine' } }; return { success: true, sessionId: 'child' }; });
        await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task })).resolves.toBe('child');
        expect(state.sessions.parent.metadata.goalBoardTaskSessions).toMatchObject({
            [sessionKey('/goals/previous', task.id)]: 'old-child', [sessionKey('/goals/feature', task.id)]: 'child',
        });
    });
    it('migrates the old feature task map before rebinding to a new feature', async () => {
        state.sessions.parent.metadata.goalBoardTaskSessions = { [task.id]: 'old-child' };
        await bindGoalBoard('parent', '/goals/another');
        expect(state.sessions.parent.metadata.goalBoardTaskSessions).toEqual({ [sessionKey('/goals/feature', task.id)]: 'old-child' });
    });
    it('rejects a task launch for a feature no longer bound to its parent', async () => {
        state.sessions.parent.metadata.goalBoard.featurePath = '/goals/new-feature';
        await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task })).rejects.toThrow(/changed|bound/i);
        expect(state.rpc).not.toHaveBeenCalled();
    });
    it('preserves explicit new-session intent even when the task has an existing session', async () => {
        state.sessions.parent.metadata.goalBoardTaskSessions = { [sessionKey('/goals/feature', task.id)]: 'existing' };
        state.rpc.mockImplementation(async () => { state.sessions.child = { id: 'child', metadataVersion: 1, metadata: { path: '/goals/feature', host: 'machine' } }; return { success: true, sessionId: 'child' }; });
        expect(await startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task, newSession: true })).toBe('child');
        expect(state.rpc).toHaveBeenCalledOnce();
    });
    it.each(['account', 'cache'])('rejects a pending startup after its %s context is invalidated', async (kind) => {
        const response = deferred<unknown>(); state.rpc.mockReturnValue(response.promise);
        const operation = startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task });
        if (kind === 'account') state.account = { key: 'other', generation: 'other' }; else clearGoalBoardRequestCache();
        response.resolve({ success: true, sessionId: 'child' });
        await expect(operation).rejects.toThrow(/expired|changed/i);
        expect(state.hydrate).not.toHaveBeenCalled(); expect(state.update).not.toHaveBeenCalled();
    });
    it('does not attach an earlier launch to a newly bound feature', async () => {
        const hydrated = deferred<boolean>(); state.hydrate.mockReturnValueOnce(hydrated.promise);
        state.rpc.mockResolvedValue({ success: true, sessionId: 'child' });
        const operation = startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task });
        await Promise.resolve(); await Promise.resolve();
        state.sessions.parent.metadata.goalBoard.featurePath = '/goals/new-feature';
        hydrated.resolve(true);
        await expect(operation).rejects.toThrow(/changed|bound/i);
        expect(state.update).not.toHaveBeenCalled();
    });
    it('reuses the same request id after initial send failure so the daemon can reuse its created child', async () => {
        state.rpc.mockResolvedValueOnce({ success: false, sessionId: 'child', error: 'send failed', title: 'Task' });
        const args = { sessionId: 'parent', featurePath: '/goals/feature', task };
        await expect(startGoalTaskSession(args)).rejects.toThrow('send failed');
        state.rpc.mockImplementationOnce(async () => { state.sessions.child = { id: 'child', metadataVersion: 1, metadata: { path: '/goals/feature', host: 'machine' } }; return { success: true, sessionId: 'child', title: 'Task' }; });
        await expect(startGoalTaskSession(args)).resolves.toBe('child');
        expect(state.rpc.mock.calls[0][2].requestId).toBe(state.rpc.mock.calls[1][2].requestId);
    });
    it('retries hydration after a confirmed launch without issuing another launch RPC', async () => {
        state.rpc.mockResolvedValue({ success: true, sessionId: 'child', title: 'Task' });
        state.hydrate.mockResolvedValueOnce(false);
        const args = { sessionId: 'parent', featurePath: '/goals/feature', task };
        await expect(startGoalTaskSession(args)).rejects.toThrow();
        state.sessions.child = { id: 'child', metadataVersion: 1, metadata: { path: '/goals/feature', host: 'machine' } };
        await expect(startGoalTaskSession(args)).resolves.toBe('child');
        expect(state.rpc).toHaveBeenCalledTimes(1);
    });
    it('bounds failed launch records while retaining a retryable request id and clearing prior account ownership', async () => {
        state.rpc.mockResolvedValue({ success: false, error: 'send failed' });
        for (let index = 0; index < 256; index += 1) {
            await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task: { ...task, id: `task-${index}` } })).rejects.toThrow('send failed');
        }
        await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task: { ...task, id: 'overflow' } })).rejects.toThrow('Too many pending');
        expect(state.rpc).toHaveBeenCalledTimes(256);
        const requestId = state.rpc.mock.calls[0][2].requestId;
        await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task: { ...task, id: 'task-0' } })).rejects.toThrow('send failed');
        expect(state.rpc.mock.calls[256][2].requestId).toBe(requestId);
        state.account = { key: 'other', generation: 'other' };
        await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task: { ...task, id: 'overflow' } })).rejects.toThrow('send failed');
        expect(state.rpc).toHaveBeenCalledTimes(258);
    });
    it('never evicts a confirmed child whose association is still incomplete merely to admit another launch', async () => {
        state.rpc.mockResolvedValue({ success: true, sessionId: 'child' }); state.hydrate.mockResolvedValue(false);
        for (let index = 0; index < 256; index += 1) {
            await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task: { ...task, id: `task-${index}` } })).rejects.toThrow('could not be loaded');
        }
        await expect(startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task: { ...task, id: 'overflow' } })).rejects.toThrow('Too many pending');
        expect(state.rpc).toHaveBeenCalledTimes(256);
        state.hydrate.mockResolvedValue(true); state.sessions.child = { id: 'child', metadataVersion: 1, metadata: { path: '/goals/feature', host: 'machine' } };
        expect(await startGoalTaskSession({ sessionId: 'parent', featurePath: '/goals/feature', task: { ...task, id: 'task-0' } })).toBe('child');
        expect(state.rpc).toHaveBeenCalledTimes(256);
    });
});
