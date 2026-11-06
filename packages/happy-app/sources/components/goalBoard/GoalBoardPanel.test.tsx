import * as React from 'react';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GoalArtifact, GoalBoardSnapshot, GoalTask } from '@slopus/happy-wire';
import { GoalBoardPanel, type GoalBoardPanelProps } from './GoalBoardPanel';
import { GoalBoardTrigger } from './GoalBoardTrigger';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ scrollTo: vi.fn(), focus: vi.fn() }));
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
    TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('react-native-unistyles', () => {
    const colors = { surface: 'surface', surfacePressed: 'pressed', surfaceSelected: 'selected',
        text: 'text', textSecondary: 'secondary', textLink: 'link', divider: 'divider', textDestructive: 'destructive' };
    return { StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory({ colors }) }, useUnistyles: () => ({ theme: { colors } }) };
});

const output: GoalArtifact = { id: 'output', name: '阶段记录 中文.md', kind: 'text', relation: 'output', description: 'Actual findings', path: '/goals/阶段记录 中文.md', available: true };
const reference: GoalArtifact = { id: 'old', name: 'Old result.md', kind: 'text', relation: 'reference', description: 'Historical comparison', available: true };
function task(id: string, overrides: Partial<GoalTask> = {}): GoalTask {
    return { id, code: id.toUpperCase(), title: `Task ${id}`, indexPath: `/goal/tasks/${id}/index.md`,
        status: 'pending', goal: `Goal ${id}`, dependencies: [], expectedDeliverables: [], artifacts: [], ...overrides };
}
function snapshot(tasks: GoalTask[]): GoalBoardSnapshot {
    return { featurePath: '/goal', title: 'Actual project goal', revision: 'rev1', updatedAt: 1, tasks, warnings: [] };
}
function props(overrides: Partial<GoalBoardPanelProps> = {}): GoalBoardPanelProps {
    return { snapshot: snapshot([task('g1')]), catalog: [], loading: false, offline: false, error: null,
        onSelectFeature: vi.fn(), onRefresh: vi.fn(), onClose: vi.fn(), onOpenArtifact: vi.fn(),
        onOpenTask: vi.fn().mockResolvedValue(undefined), getTaskSessionId: () => null, ...overrides };
}
let renderers: any[] = [];
function render(input: GoalBoardPanelProps) {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<GoalBoardPanel {...input} />, {
        createNodeMock: (element: any) => element.type === 'ScrollView' ? { scrollTo: mocks.scrollTo } : { focus: mocks.focus },
    }); });
    renderers.push(renderer);
    return renderer;
}
function press(renderer: any, testID: string) { act(() => renderer.root.findByProps({ testID }).props.onPress()); }
function button(renderer: any, testID: string) { return renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === testID); }
function json(renderer: any) { return JSON.stringify(renderer.toJSON()); }
function rowIds(renderer: any) { return renderer.root.findAllByType('Pressable').filter((n: any) => n.props.testID?.startsWith('goal-board-task-')).map((n: any) => n.props.testID); }

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const original = console.error;
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (args[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
        original(...args);
    });
});
afterAll(() => errorSpy.mockRestore());
afterEach(() => { for (const renderer of renderers) act(() => renderer.unmount()); renderers = []; vi.clearAllMocks(); });

describe('GoalBoardPanel', () => {
    it('counts actual done records and retains unknown task status', () => {
        const renderer = render(props({ snapshot: snapshot([task('g1', { status: 'done' }), task('g2', { status: 'review' }), task('g3', { status: 'unknown' })]) }));
        expect(json(renderer)).toContain('goalBoard.completed:{\\"completed\\":1,\\"total\\":3}');
        expect(renderer.root.findByProps({ testID: 'goal-board-task-g3' }).findAllByType('Text').map((n: any) => n.props.children)).toContain('goalBoard.status.unknown');
    });

    it('searches local records and combines status and real current batch filters without RPC', () => {
        const input = props({ snapshot: snapshot([
            task('g1', { title: '当前 中文记录', status: 'running', batch: 'Batch A' }),
            task('g2', { title: 'Later record', status: 'pending', batch: 'Batch B' }),
            task('g3', { title: 'Current done', status: 'done', batch: 'Batch A' }),
        ]) });
        const renderer = render(input);
        press(renderer, 'goal-board-current-batch');
        expect(rowIds(renderer)).toEqual(['goal-board-task-g1', 'goal-board-task-g3']);
        press(renderer, 'goal-board-filter-running');
        act(() => renderer.root.findByProps({ testID: 'goal-board-search' }).props.onChangeText('中文'));
        expect(rowIds(renderer)).toEqual(['goal-board-task-g1']);
        act(() => renderer.root.findByProps({ testID: 'goal-board-search' }).props.onChangeText('missing'));
        expect(rowIds(renderer)).toEqual([]);
        expect(json(renderer)).toContain('goalBoard.noMatches');
        expect(input.onRefresh).not.toHaveBeenCalled();
        expect(input.onSelectFeature).not.toHaveBeenCalled();
    });

    it('does not invent a current batch from ambiguous or absent records', () => {
        const renderer = render(props({ snapshot: snapshot([task('g1', { status: 'running', batch: 'A' }), task('g2', { status: 'running', batch: 'B' })]) }));
        expect(renderer.root.findAllByProps({ testID: 'goal-board-current-batch' })).toHaveLength(0);
    });

    it('prioritizes goal, problem, stage and actual original artifacts while keeping planned and historical material collapsed', () => {
        const selected = task('g1', { goal: 'Clear goal', problem: 'Real problem', stage: 'Validation', expectedDeliverables: ['Future website'], artifacts: [reference, output] });
        const input = props({ snapshot: snapshot([selected]) });
        const renderer = render(input);
        press(renderer, 'goal-board-task-g1');
        const text = json(renderer);
        expect(text.indexOf('Clear goal')).toBeLessThan(text.indexOf('Real problem'));
        expect(text.indexOf('Real problem')).toBeLessThan(text.indexOf('Validation'));
        expect(text.indexOf('Validation')).toBeLessThan(text.indexOf(output.name));
        expect(text).not.toContain('Future website');
        expect(text).not.toContain(reference.name);
        press(renderer, 'goal-board-artifact-output');
        expect(input.onOpenArtifact).toHaveBeenCalledWith(selected, output);
        press(renderer, 'goal-board-expected');
        expect(json(renderer)).toContain('Future website');
        press(renderer, 'goal-board-references');
        expect(json(renderer)).toContain(reference.name);
        press(renderer, 'goal-board-artifact-old');
        expect(input.onOpenArtifact).toHaveBeenLastCalledWith(selected, reference);
    });

    it('does not treat reference documents or expected outputs as actual deliverables', () => {
        const renderer = render(props({ snapshot: snapshot([task('g1', { artifacts: [reference], expectedDeliverables: ['Contract'] })]) }));
        press(renderer, 'goal-board-task-g1');
        expect(json(renderer)).toContain('goalBoard.noDeliverables');
        expect(json(renderer)).toContain('goalBoard.unknownField');
        expect(json(renderer)).not.toContain('Contract');
    });

    it('preserves cached content offline and prevents actions that need the machine', () => {
        const input = props({ offline: true, snapshot: snapshot([task('g1', { artifacts: [output] })]) });
        const renderer = render(input);
        expect(json(renderer)).toContain('goalBoard.offline');
        press(renderer, 'goal-board-task-g1');
        expect(renderer.root.findByProps({ testID: 'goal-board-artifact-output' }).props.disabled).toBe(true);
        expect(renderer.root.findByProps({ testID: 'goal-board-open-task' }).props.disabled).toBe(true);
    });

    it.each([
        [{ loading: true, snapshot: null }, 'goalBoard.loading'],
        [{ offline: true, snapshot: null }, 'goalBoard.offlineEmpty'],
        [{ error: 'Permission denied', snapshot: null }, 'Permission denied'],
        [{ snapshot: snapshot([]) }, 'goalBoard.empty'],
        [{ snapshot: null }, 'goalBoard.noGoals'],
    ])('shows an honest state for %j', (overrides, expected) => {
        const renderer = render(props(overrides));
        expect(json(renderer)).toContain(expected);
    });

    it('links the exact catalog entry and keeps refresh and close user-triggered', () => {
        const entry = { featurePath: '/goals/中文 feature', title: 'Goal to link', projectTitle: 'Project' };
        const input = props({ snapshot: null, catalog: [entry] });
        const renderer = render(input);
        press(renderer, 'goal-board-feature-0');
        expect(input.onSelectFeature).toHaveBeenCalledWith(entry);
        press(renderer, 'goal-board-refresh');
        press(renderer, 'goal-board-close');
        expect(input.onRefresh).toHaveBeenCalledOnce();
        expect(input.onClose).toHaveBeenCalledOnce();
    });

    it('disables missing original files', () => {
        const renderer = render(props({ snapshot: snapshot([task('g1', { artifacts: [{ ...output, available: false }] })]) }));
        press(renderer, 'goal-board-task-g1');
        expect(renderer.root.findByProps({ testID: 'goal-board-artifact-output' }).props.disabled).toBe(true);
        expect(json(renderer)).toContain('goalBoard.unavailable');
    });

    it('opens the exact task once while busy and supports explicitly opening another session', async () => {
        let finish!: () => void;
        const selected = task('g1');
        const input = props({ snapshot: snapshot([selected]), getTaskSessionId: () => 'existing-session', onOpenTask: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
        const renderer = render(input);
        press(renderer, 'goal-board-task-g1');
        expect(json(renderer)).toContain('goalBoard.continueTask');
        const onPress = renderer.root.findByProps({ testID: 'goal-board-open-task' }).props.onPress;
        act(() => { onPress(); onPress(); });
        expect(input.onOpenTask).toHaveBeenCalledTimes(1);
        expect(input.onOpenTask).toHaveBeenLastCalledWith(selected, false);
        expect(renderer.root.findByProps({ testID: 'goal-board-new-task' }).props.disabled).toBe(true);
        await act(async () => { finish(); await Promise.resolve(); });
        press(renderer, 'goal-board-new-task');
        expect(input.onOpenTask).toHaveBeenLastCalledWith(selected, true);
        await act(async () => { finish(); await Promise.resolve(); });
    });

    it('shows failed session creation and releases the action for retry', async () => {
        const renderer = render(props({ onOpenTask: vi.fn().mockRejectedValue(new Error('failed')) }));
        press(renderer, 'goal-board-task-g1');
        await act(async () => { renderer.root.findByProps({ testID: 'goal-board-open-task' }).props.onPress(); await Promise.resolve(); });
        expect(json(renderer)).toContain('goalBoard.taskError');
        expect(renderer.root.findByProps({ testID: 'goal-board-open-task' }).props.disabled).toBe(false);
    });

    it('does not show an earlier task session failure on a newly selected task', async () => {
        let fail!: (error: Error) => void;
        const input = props({ snapshot: snapshot([task('g1'), task('g2')]), onOpenTask: vi.fn(() => new Promise<void>((_, reject) => { fail = reject; })) });
        const renderer = render(input);
        press(renderer, 'goal-board-task-g1');
        press(renderer, 'goal-board-open-task');
        press(renderer, 'goal-board-back');
        press(renderer, 'goal-board-task-g2');
        await act(async () => { fail(new Error('earlier task failed')); await Promise.resolve(); });
        expect(json(renderer)).not.toContain('goalBoard.taskError');
    });

    it('respects external opening state and blocks both session actions', () => {
        const input = props({ openingTaskId: 'another-task', getTaskSessionId: () => 'existing' });
        const renderer = render(input);
        press(renderer, 'goal-board-task-g1');
        expect(button(renderer, 'goal-board-open-task').props.disabled).toBe(true);
        expect(button(renderer, 'goal-board-new-task').props.disabled).toBe(true);
        expect(button(renderer, 'goal-board-open-task').props.accessibilityState).toMatchObject({ busy: true });
    });

    it('resets detail scroll and restores focus to its task row on back', () => {
        const renderer = render(props());
        press(renderer, 'goal-board-task-g1');
        expect(mocks.scrollTo).toHaveBeenCalledWith({ y: 0, animated: false });
        press(renderer, 'goal-board-back');
        expect(rowIds(renderer)).toEqual(['goal-board-task-g1']);
        expect(mocks.focus).toHaveBeenCalled();
    });

    it('drops stale detail selection after a feature switch and keeps callbacks attached to the new snapshot', () => {
        const input = props();
        const renderer = render(input);
        press(renderer, 'goal-board-task-g1');
        const changed = { ...snapshot([task('g2')]), featurePath: '/different-goal' };
        act(() => renderer.update(<GoalBoardPanel {...input} snapshot={changed} />));
        expect(rowIds(renderer)).toEqual(['goal-board-task-g2']);
        expect(json(renderer)).not.toContain('Goal g1');
    });

    it('uses semantic interaction surfaces and announces selected filters', () => {
        const renderer = render(props());
        const filter = button(renderer, 'goal-board-filter-all');
        expect(filter.props.accessibilityState).toMatchObject({ selected: true });
        expect(filter.props.style({ pressed: false, hovered: false })).toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: 'selected' })]));
        expect(filter.props.style({ pressed: false, hovered: true })).toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: 'pressed' })]));
        act(() => filter.props.onFocus());
        expect(button(renderer, 'goal-board-filter-all').props.style({ pressed: false })).toEqual(expect.arrayContaining([expect.objectContaining({ borderColor: 'link' })]));
    });
});

describe('GoalBoardTrigger', () => {
    it('shows real counts, exposes expanded state and invokes the toggle callback', () => {
        const onPress = vi.fn();
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<GoalBoardTrigger completed={2} total={7} open onPress={onPress} />); });
        renderers.push(renderer);
        const trigger = button(renderer, 'goal-board-trigger');
        expect(trigger.props.accessibilityState).toMatchObject({ expanded: true });
        expect(json(renderer)).toContain('goalBoard.trigger:{\\"completed\\":2,\\"total\\":7}');
        press(renderer, 'goal-board-trigger');
        expect(onPress).toHaveBeenCalledOnce();
    });
});
