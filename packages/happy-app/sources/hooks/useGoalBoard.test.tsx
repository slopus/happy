import * as React from 'react';
import { act } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import type { GoalBoardSnapshot, GoalTask } from '@slopus/happy-wire';
const mocks = vi.hoisted(() => ({ sessions: {} as Record<string, any>, catalog: vi.fn(), read: vi.fn(), bind: vi.fn(), start: vi.fn(), account: { key: 'account', generation: 'gen1' } }));
vi.mock('@/sync/storage', () => ({ useSession: (id: string) => mocks.sessions[id] ?? null }));
vi.mock('@/sync/goalBoard', () => ({ loadGoalBoardCatalog: mocks.catalog, loadGoalBoardSnapshot: mocks.read, bindGoalBoard: mocks.bind, startGoalTaskSession: mocks.start,
    getGoalTaskSessionId: (metadata: any, featurePath: string, taskId: string) => metadata?.goalBoardTaskSessions?.[JSON.stringify([featurePath, taskId])] ?? null }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: vi.fn(), getRuntimeAccountSelection: () => mocks.account }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { useGoalBoard } from './useGoalBoard';
const snapshot = (featurePath = '/feature', revision = 'v1'): GoalBoardSnapshot => ({ featurePath, revision, title: 'Goal', updatedAt: 1, tasks: [], warnings: [] });
const task: GoalTask = { id: 't1', title: 'Task', goal: 'Goal', indexPath: '/feature/tasks/t1/index.md', status: 'running', dependencies: [], expectedDeliverables: [], artifacts: [] };
let current: ReturnType<typeof useGoalBoard>;
function Harness({ id = 's1', open = false }: { id?: string; open?: boolean }) { current = useGoalBoard(id, open); return null; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { vi.clearAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.account = { key: 'account', generation: 'gen1' }; mocks.sessions = { s1: { id: 's1', presence: 'online', metadata: { path: '/workspace', goalBoard: { featurePath: '/feature' } } } }; mocks.catalog.mockResolvedValue([]); mocks.read.mockResolvedValue(snapshot()); mocks.start.mockResolvedValue('child'); });
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    const original = console.error;
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (args[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
        original(...args);
    });
});
afterAll(() => errorSpy.mockRestore());

describe('useGoalBoard lazy event-driven state', () => {
    it('does no RPC while closed and reuses the loaded board across close/open', async () => {
        let view: any; await act(async () => { view = TestRenderer.create(<Harness />); });
        expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.catalog).not.toHaveBeenCalled();
        await act(async () => { view.update(<Harness open />); });
        expect(mocks.read).toHaveBeenCalledTimes(1); expect(current!.snapshot?.revision).toBe('v1');
        await act(async () => { view.update(<Harness />); }); await act(async () => { view.update(<Harness open />); });
        expect(mocks.read).toHaveBeenCalledTimes(1); expect(mocks.catalog).toHaveBeenCalledTimes(1);
        act(() => view.unmount());
    });
    it('renders the durable snapshot offline without attempting to read', async () => {
        mocks.sessions.s1.presence = 1; mocks.sessions.s1.metadata.goalBoardSnapshot = snapshot();
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        expect(current!.offline).toBe(true); expect(current!.snapshot?.title).toBe('Goal'); expect(mocks.read).not.toHaveBeenCalled();
        act(() => view.unmount());
    });
    it('accepts a later metadata revision without a follow-up query', async () => {
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        mocks.sessions.s1.metadata.goalBoardSnapshot = { ...snapshot('/feature', 'v2'), updatedAt: 2 };
        await act(async () => { view.update(<Harness open />); });
        expect(current!.snapshot?.revision).toBe('v2'); expect(mocks.read).toHaveBeenCalledTimes(1);
        act(() => view.unmount());
    });
    it('ignores a response that belongs to the previously viewed session', async () => {
        const first = deferred<GoalBoardSnapshot>(); mocks.read.mockImplementationOnce(() => first.promise);
        mocks.sessions.s2 = { id: 's2', presence: 'online', metadata: { path: '/workspace2', goalBoard: { featurePath: '/other' } } };
        mocks.read.mockImplementationOnce(async () => snapshot('/other', 'other'));
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        await act(async () => { view.update(<Harness id="s2" open />); });
        await act(async () => { first.resolve(snapshot()); });
        expect(current!.snapshot?.featurePath).toBe('/other'); expect(current!.snapshot?.revision).toBe('other');
        act(() => view.unmount());
    });
    it('keeps cached data on failure and does not retry until a user refresh', async () => {
        mocks.sessions.s1.metadata.goalBoardSnapshot = snapshot(); mocks.read.mockRejectedValue(new Error('Method not found'));
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        expect(current!.snapshot?.revision).toBe('v1'); expect(current!.error).toContain('goalBoard.unsupportedWorker');
        await act(async () => { view.update(<Harness open />); }); expect(mocks.read).toHaveBeenCalledTimes(1);
        mocks.read.mockResolvedValue(snapshot('/feature', 'v3')); await act(async () => { await current!.refresh(); });
        expect(mocks.read).toHaveBeenCalledTimes(2); expect(current!.error).toBeNull();
        act(() => view.unmount());
    });
    it('reinstalls the board watcher once after an offline-to-online event', async () => {
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        expect(mocks.read).toHaveBeenCalledTimes(1);
        mocks.sessions.s1.presence = 2; await act(async () => { view.update(<Harness open />); });
        mocks.sessions.s1.presence = 'online'; await act(async () => { view.update(<Harness open />); });
        expect(mocks.read).toHaveBeenCalledTimes(2);
        await act(async () => { view.update(<Harness open />); });
        expect(mocks.read).toHaveBeenCalledTimes(2);
        act(() => view.unmount());
    });
    it.each(['session', 'feature', 'account', 'unmount'])('rejects a task-session result after its %s context changes so the host cannot navigate', async (kind) => {
        const started = deferred<string>(); mocks.start.mockReturnValue(started.promise);
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        let operation!: Promise<string>;
        act(() => { operation = current!.openTask(task, false); });
        if (kind === 'session') {
            mocks.sessions.s2 = { id: 's2', presence: 'online', metadata: { goalBoard: { featurePath: '/feature' } } };
            await act(async () => { view.update(<Harness id="s2" open />); });
        } else if (kind === 'feature') {
            mocks.sessions.s1.metadata.goalBoard.featurePath = '/other';
            await act(async () => { view.update(<Harness open />); });
        } else if (kind === 'account') {
            mocks.account = { key: 'other', generation: 'gen2' };
            // Account guard must also work before a React rerender occurs.
        } else act(() => view.unmount());
        started.resolve('child');
        await act(async () => { await expect(operation).rejects.toThrow(/expired|changed/i); });
        if (kind !== 'unmount') act(() => view.unmount());
    });
    it('never restores a catalog from an earlier visit after switching sessions away and back', async () => {
        const first = deferred<any[]>(); const second = deferred<any[]>();
        mocks.catalog.mockReturnValueOnce(first.promise).mockResolvedValueOnce([]).mockReturnValueOnce(second.promise);
        mocks.sessions.s2 = { id: 's2', presence: 'online', metadata: {} };
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        await act(async () => { view.update(<Harness id="s2" open />); });
        await act(async () => { view.update(<Harness open />); });
        await act(async () => { second.resolve([{ featurePath: '/new', title: 'New catalog' }]); });
        await act(async () => { first.resolve([{ featurePath: '/old', title: 'Old catalog' }]); });
        expect(current!.catalog.map(entry => entry.title)).toEqual(['New catalog']);
        act(() => view.unmount());
    });
    it('keeps task session associations scoped to the current feature', async () => {
        mocks.sessions.s1.metadata.goalBoardTaskSessions = { [JSON.stringify(['/feature', task.id])]: 'first-child', [JSON.stringify(['/other', task.id])]: 'other-child' };
        let view: any; await act(async () => { view = TestRenderer.create(<Harness />); });
        expect(current!.getTaskSessionId(task)).toBe('first-child');
        mocks.sessions.s1.metadata.goalBoard.featurePath = '/other';
        await act(async () => { view.update(<Harness />); });
        expect(current!.getTaskSessionId(task)).toBe('other-child');
        act(() => view.unmount());
    });
    it('reinstalls the feature watcher after switching features and returning, without reloading for close/open', async () => {
        mocks.read.mockImplementation(async (id: string, featurePath: string) => snapshot(featurePath));
        let view: any; await act(async () => { view = TestRenderer.create(<Harness open />); });
        mocks.sessions.s1.metadata.goalBoard.featurePath = '/other';
        await act(async () => { view.update(<Harness open />); });
        mocks.sessions.s1.metadata.goalBoard.featurePath = '/feature';
        await act(async () => { view.update(<Harness open />); });
        expect(mocks.read.mock.calls.map(call => call[1])).toEqual(['/feature', '/other', '/feature']);
        await act(async () => { view.update(<Harness />); });
        await act(async () => { view.update(<Harness open />); });
        expect(mocks.read).toHaveBeenCalledTimes(3);
        act(() => view.unmount());
    });
});
