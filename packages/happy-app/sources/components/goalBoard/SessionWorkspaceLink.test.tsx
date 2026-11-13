import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ navigate: vi.fn(), alert: vi.fn(), owner: { generation: 'one' }, current: true,
    projects: vi.fn(), board: vi.fn(), deleted: false, flush: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: mock.navigate }) }));
vi.mock('react-native', () => ({ Text: 'Text' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textLink: 'theme-link' } } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { alert: mock.alert } }));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => mock.owner, accountRuntimeCurrent: () => mock.current }));
vi.mock('@/sync/projectGoals', () => ({ loadGoalProjects: mock.projects, loadProjectGoalBoard: mock.board }));
vi.mock('@/sync/projectSessionLinks', () => ({ isProjectSessionDeleted: () => mock.deleted }));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: 'Button' }));
import { SessionWorkspaceLink } from './SessionWorkspaceLink';

const projects = [{ projectPath: '/p', title: 'Project', features: [{ featurePath: '/p/f', title: 'Goal' }] }];
const metadata = { machineId: 'm', path: '/p/f/tasks/t', goalBoard: { featurePath: '/p/f', taskId: 'task' } };
const board = { snapshot: { featurePath: '/p/f', tasks: [{ id: 'task', indexPath: '/p/f/tasks/t/index.md' }] } };
let renderer: any;
async function render(patch: Record<string, unknown> = {}) {
    await act(async () => {
        const element = <SessionWorkspaceLink id="older" metadata={metadata} focused beforeNavigate={mock.flush} {...patch} />;
        if (renderer) renderer.update(element); else renderer = TestRenderer.create(element);
    });
}
const button = () => renderer.root.findByType('Button');
async function press() { await act(async () => { button().props.onPress(); }); }
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); mock.current = true; mock.deleted = false; mock.owner = { generation: 'one' };
    mock.projects.mockResolvedValue(projects); mock.board.mockResolvedValue(board);
});
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });

it('flushes the latest draft before navigating to the exact older task conversation', async () => {
    await render(); expect(mock.navigate).not.toHaveBeenCalled();
    await press();
    expect(mock.navigate.mock.calls[0][0].params).toMatchObject({ project: '/p', feature: '/p/f', task: 'task', conversation: 'older' });
    expect(mock.flush.mock.invocationCallOrder[0]).toBeLessThan(mock.navigate.mock.invocationCallOrder[0]);
});
it.each([true, false])('opens a verified embedded global/task session directly in the ordinary page (hasTask=%s)', async hasTask => {
    await render({ embedded: true, metadata: hasTask ? metadata : { machineId: 'm', path: '/p/f' } });
    await press(); expect(mock.navigate).toHaveBeenCalledExactlyOnceWith('/session/older');
    expect(mock.projects).not.toHaveBeenCalled(); expect(mock.board).not.toHaveBeenCalled(); expect(mock.flush).toHaveBeenCalledTimes(1);
});
it('updates the ordinary destination when the selected embedded conversation changes and rejects retained callbacks', async () => {
    await render({ embedded: true }); const old = button().props.onPress;
    await render({ embedded: true, id: 'newer' }); old(); await press();
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith('/session/newer');
});
it('discovers a global legacy session from the catalog without task metadata', async () => {
    await render({ metadata: { machineId: 'm', path: '/p/f' } }); await press();
    expect(mock.navigate.mock.calls[0][0].params).toMatchObject({ project: '/p', feature: '/p/f', author: 'older', task: undefined });
});
it('hides the workspace action on unrelated ordinary sessions', async () => {
    await render({ metadata: { machineId: 'm', path: '/unrelated' } });
    expect(renderer.root.findAllByType('Button')).toHaveLength(0); expect(mock.navigate).not.toHaveBeenCalled();
});
it('hides an inferred task directory when the authoritative task no longer exists', async () => {
    mock.board.mockResolvedValue({ snapshot: { featurePath: '/p/f', tasks: [] } });
    await render({ metadata: { machineId: 'm', path: '/p/f/tasks/removed' } });
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
});
it('reports invalid ownership instead of falling back to a different/latest conversation', async () => {
    await render(); mock.board.mockResolvedValue({ snapshot: { featurePath: '/p/f', tasks: [] } }); await press();
    expect(mock.alert).toHaveBeenCalled(); expect(mock.navigate).not.toHaveBeenCalled(); expect(mock.flush).not.toHaveBeenCalled();
});
it('allows a user retry after a read failure without starting automatic retries', async () => {
    mock.projects.mockRejectedValue(new Error('offline')); await render();
    expect(mock.projects).toHaveBeenCalledTimes(1); await press(); expect(mock.alert).toHaveBeenCalled();
    mock.projects.mockResolvedValue(projects); await press(); expect(mock.navigate).toHaveBeenCalledTimes(1);
});
it.each(['session', 'blur', 'unmount', 'account'])('discards an in-flight click after %s changes', async change => {
    await render(); let resolve!: (value: any) => void;
    mock.projects.mockReturnValue(new Promise(done => { resolve = done; }));
    act(() => { button().props.onPress(); });
    if (change === 'session') await render({ id: 'other', metadata: { machineId: 'm', path: '/unrelated' } });
    if (change === 'blur') await render({ focused: false });
    if (change === 'unmount') { act(() => renderer.unmount()); renderer = undefined; }
    if (change === 'account') mock.owner = { generation: 'two' };
    await act(async () => { resolve(projects); });
    expect(mock.navigate).not.toHaveBeenCalled(); expect(mock.flush).not.toHaveBeenCalled();
});
it('does not navigate a deleted association or a frozen account', async () => {
    await render(); mock.deleted = true; await press(); expect(mock.alert).toHaveBeenCalled();
    mock.current = false; await render({ embedded: true }); await press(); expect(mock.navigate).not.toHaveBeenCalled();
});
