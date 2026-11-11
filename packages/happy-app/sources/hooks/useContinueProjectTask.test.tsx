import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalTask } from '@slopus/happy-wire';
import { useContinueProjectTask } from './useContinueProjectTask';

const mocks = vi.hoisted(() => ({ open: vi.fn(), write: vi.fn(), blur: () => {}, headers: {} as Record<string, any> }));
vi.mock('expo-router', () => ({ useFocusEffect: (callback: () => () => void) => React.useEffect(() => { mocks.blur = callback(); return mocks.blur; }, [callback]) }));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => ({ key: 'a', generation: 1, serverUrl: 's' }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: mocks.headers }) } }));
vi.mock('@/sync/projectGoals', () => ({ openProjectGoalConversation: mocks.open }));
vi.mock('@/sync/mergeProjectTaskHistory', () => ({ mergeProjectTaskHistory: (known: any[], headers: any[]) => [...known, ...headers] }));
vi.mock('@/sync/projectWorkspaceCache', () => ({ projectCacheKey: (...args: string[]) => args.join(':'), projectHistorySchema: {}, readProjectCache: () => null, writeProjectCache: mocks.write }));
let renderer: any;
let api: ReturnType<typeof useContinueProjectTask>;
const onOpened = vi.fn();
const task = { id: 't', indexPath: '/f/tasks/t/index.md' } as GoalTask;
const session = { sessionId: 's', directory: '/f/tasks/t', updatedAt: 1, title: 's', executed: false };
function Host({ machineId = 'm' }: { machineId?: string }) { api = useContinueProjectTask({ machineId, featurePath: '/f', agent: 'codex', onOpened }); return null; }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mocks.headers = {}; act(() => { renderer = TestRenderer.create(<Host />); }); });
afterEach(() => act(() => renderer.unmount()));
describe('Task card async continuation', () => {
    it('retries an uncertain launch with the same request ID and does not navigate on failure', async () => {
        mocks.open.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ session, created: true });
        await act(async () => { await api.continueTask(task); });
        expect(api.error).toBe('response lost'); expect(onOpened).not.toHaveBeenCalled();
        await act(async () => { await api.continueTask(task); });
        expect(mocks.open.mock.calls[0][3]).toBe(mocks.open.mock.calls[1][3]);
        expect(onOpened).toHaveBeenCalledExactlyOnceWith('t', 's');
    });
    it('coalesces double taps and never navigates a retained screen after blur', async () => {
        let resolve!: (value: any) => void;
        mocks.open.mockImplementation(() => new Promise(value => { resolve = value; }));
        let pending!: Promise<void>;
        act(() => { pending = api.continueTask(task); void api.continueTask(task); });
        expect(mocks.open).toHaveBeenCalledTimes(1);
        act(() => mocks.blur());
        await act(async () => { resolve({ session }); await pending; });
        expect(onOpened).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    });
    it('rejects a late result after switching machine scope', async () => {
        let resolve!: (value: any) => void;
        mocks.open.mockImplementation(() => new Promise(value => { resolve = value; }));
        let pending!: Promise<void>;
        act(() => { pending = api.continueTask(task); renderer.update(<Host machineId="other" />); });
        await act(async () => { resolve({ session }); await pending; });
        expect(onOpened).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    });
});
