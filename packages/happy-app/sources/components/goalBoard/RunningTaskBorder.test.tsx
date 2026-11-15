import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { create } from 'zustand';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GoalTask } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';

const store = create<{ sessions: Record<string, Session> }>(() => ({ sessions: {} }));
const cache = vi.hoisted(() => ({ history: [] as any[] }));
vi.mock('@/sync/storage', () => ({ storage: (...args: any[]) => (store as any)(...args) }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/sync/ops', () => ({}));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => ({ key: 'account', serverUrl: 'server', generation: 1 }) }));
vi.mock('@/sync/projectWorkspaceCache', () => ({
    projectCacheKey: (...parts: string[]) => parts.join(':'), projectHistorySchema: {},
    readProjectCache: () => ({ value: { sessions: cache.history } }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textLink: 'blue' } } }) }));
import { RunningTaskBorder } from './RunningTaskBorder.web';
import { markProjectSessionDeleted } from '@/sync/projectSessionLinks';

const task: GoalTask = { id: 't', title: 'Task', goal: '', indexPath: '/f/tasks/t/index.md', status: 'review', dependencies: [], expectedDeliverables: [], artifacts: [] };
function session(id: string, patch: Partial<Session> = {}): Session {
    return { id, updatedAt: 1, active: true, presence: 'online', thinking: false,
        metadata: { host: 'test', machineId: 'm', path: '/f/tasks/t', goalBoard: { featurePath: '/f', taskId: 't' } },
        agentState: { turnStatus: { status: 'running', updatedAt: 1 } }, ...patch } as Session;
}
let view: any;
function mount(patch: any = {}) {
    act(() => { view = TestRenderer.create(<RunningTaskBorder {...{ machineId: 'm', featurePath: '/f', task, ...patch }} />); });
}
const glows = () => view.root.findAllByProps({ className: 'paws-task-flow' }).length;
const update = (sessions: Session[]) => act(() => store.setState({ sessions: Object.fromEntries(sessions.map(s => [s.id, s])) }));
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; store.setState({ sessions: {} }); cache.history = []; });
afterEach(() => { act(() => view?.unmount()); view = undefined; });

it('starts and stops on live session events while the task remains awaiting review', () => {
    mount(); expect(glows()).toBe(0);
    update([session('live')]); expect(glows()).toBe(1);
    update([session('live', { agentState: { turnStatus: { status: 'completed', updatedAt: 2 } } })]); expect(glows()).toBe(0);
    update([session('live', { thinking: true, agentState: null })]); expect(glows()).toBe(1);
    update([session('live', { agentState: { turnStatus: { status: 'failed', updatedAt: 3 } } })]); expect(glows()).toBe(0);
    expect(task.status).toBe('review');
});

it('keeps the glow until every associated conversation has stopped', () => {
    mount();
    update([session('old'), session('new', { agentState: { turnStatus: { status: 'completed', updatedAt: 2 } } })]); expect(glows()).toBe(1);
    update([session('old', { agentState: null }), session('new', { agentState: null })]); expect(glows()).toBe(0);
});

it.each([
    ['other task', { metadata: { host: 'test', machineId: 'm', path: '/f/tasks/t', goalBoard: { featurePath: '/f', taskId: 'other' } } }],
    ['other feature', { metadata: { host: 'test', machineId: 'm', path: '/f/tasks/t', goalBoard: { featurePath: '/other', taskId: 't' } } }],
    ['global conversation', { metadata: { host: 'test', machineId: 'm', path: '/f/tasks/t', goalBoard: { featurePath: '/f' } } }],
    ['other machine', { metadata: { host: 'test', machineId: 'other', path: '/f/tasks/t' } }],
    ['offline', { presence: 123 }],
    ['archived', { metadata: { host: 'test', machineId: 'm', path: '/f/tasks/t', lifecycleState: 'archived' } }],
    ['permission required', { agentState: { requests: { req: { tool: 'shell', arguments: {}, createdAt: 1 } } } }],
] as const)('does not animate for %s', (_label, patch) => {
    update([session('unrelated', patch as Partial<Session>)]);
    mount({ task: { ...task, status: 'running' } });
    expect(glows()).toBe(0);
});

it('matches legacy task directories and canonicalized cached associations', () => {
    mount();
    update([session('legacy', { metadata: { host: 'test', machineId: 'm', path: '/f/tasks/t/' } })]); expect(glows()).toBe(1);
    cache.history = [{ sessionId: 'alias', directory: '/f/tasks/t', updatedAt: 1, title: 'Alias', executed: true }];
    act(() => view.update(<RunningTaskBorder machineId="m" featurePath="/f" task={task} />));
    update([session('alias', { metadata: { host: 'test', machineId: 'm', path: '/alias/to/task' } })]); expect(glows()).toBe(1);
    update([session('alias', { metadata: { host: 'test', machineId: 'm', path: '/alias/to/task', goalBoard: { featurePath: '/f', taskId: 'other' } } })]); expect(glows()).toBe(0);
});

it('stops immediately when an associated session is authoritatively deleted', () => {
    update([session('deleted-live')]); mount(); expect(glows()).toBe(1);
    act(() => markProjectSessionDeleted('deleted-live')); expect(glows()).toBe(0);
});

it('does not retain a glow after changing machines or features', () => {
    update([session('scoped')]); mount(); expect(glows()).toBe(1);
    act(() => view.update(<RunningTaskBorder machineId="other" featurePath="/f" task={task} />)); expect(glows()).toBe(0);
    act(() => view.update(<RunningTaskBorder machineId="m" featurePath="/other" task={task} />)); expect(glows()).toBe(0);
});

it.each(['pending', 'review', 'done', 'running'] as const)('uses live execution independently of the task status %s', status => {
    const archivedTask = Object.freeze({ ...task, status });
    mount({ task: archivedTask }); expect(glows()).toBe(0);
    update([session('independent')]); expect(glows()).toBe(1);
    update([]); expect(glows()).toBe(0);
    expect(archivedTask.status).toBe(status);
});
