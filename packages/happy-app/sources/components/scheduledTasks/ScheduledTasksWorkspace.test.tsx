// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledRun } from '@slopus/happy-wire';
import type { DecryptedScheduledTask, ScheduledTasksSnapshot } from '@/sync/scheduledTasks';
import { ScheduledTasksWorkspace } from './ScheduledTasksWorkspace';

const mocks = vi.hoisted(() => ({
    focused: true, params: { taskId: '00000000-0000-4000-8000-000000000001' as string | undefined, runId: undefined as string | undefined },
    snapshot: null as unknown as ScheduledTasksSnapshot, listeners: new Set<() => void>(),
    runNow: vi.fn(), history: vi.fn().mockResolvedValue(undefined), refresh: vi.fn().mockResolvedValue(undefined),
    setVisible: vi.fn(), push: vi.fn(), setParams: vi.fn(),
    machines: [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '/work', displayName: 'Test machine' } }],
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 1440, height: 900 }), BackHandler: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: 'text', textSecondary: 'muted', textLink: 'link', divider: 'divider', input: { background: 'input' }, surface: 'surface', surfaceSelected: 'selected', surfacePressed: 'pressed', textDestructive: 'error' } };
    return { StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory(theme), hairlineWidth: 1 }, useUnistyles: () => ({ theme }) };
});
vi.mock('expo-router', async () => {
    const react = await import('react'); const router = { push: mocks.push, setParams: mocks.setParams };
    return { useRouter: () => router, useLocalSearchParams: () => mocks.params,
        useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(() => mocks.focused ? callback() : undefined, [callback, mocks.focused]) };
});
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemList', () => ({ ItemList: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./TaskEditor', () => ({ TaskEditor: () => null }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => mocks.machines }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: (machine: { active: boolean }) => machine.active }));
vi.mock('@/sync/sync', () => ({ sync: { scheduledTasks: {
    subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
    getSnapshot: () => mocks.snapshot, setVisible: mocks.setVisible, refresh: mocks.refresh, history: mocks.history,
    runNow: mocks.runNow, toggle: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined), abandon: vi.fn().mockResolvedValue(undefined),
} } }));
const taskId = '00000000-0000-4000-8000-000000000001'; const runId = '00000000-0000-4000-8000-000000000002';
const task: DecryptedScheduledTask = { id: taskId, machineId: 'machine', rule: { type: 'daily', time: '09:00', timezone: 'UTC' },
    encryptedConfig: 'cipher', enabled: true, newChatEachRun: false, notificationPolicy: 'none', version: 0,
    nextAt: Date.now() + 86400000, createdAt: 1, updatedAt: 1, activeRunId: null, bindingVersion: 0, conversationSessionId: null,
    config: { title: 'Test scheduled task', prompt: 'Read a public page', directory: '/work', agent: 'codex', permissionMode: 'read-only' } };
function run(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
    return { id: runId, taskId, machineId: 'machine', scheduledAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
        status: 'pending', encryptedConfig: 'cipher', newChatEachRun: false, bindingVersion: 0, notificationPolicy: 'none',
        claimId: null, sessionId: null, turnId: null, startedAt: null, finishedAt: null, reason: null, missedUntil: null, deadlineAt: null,
        conversationSessionId: null, reportSequence: 0, ...overrides };
}
let renderer: ReturnType<typeof TestRenderer.create> | undefined;
function publish(patch: Partial<ScheduledTasksSnapshot>) { mocks.snapshot = { ...mocks.snapshot, ...patch }; for (const listener of mocks.listeners) listener(); }
function stage(value: ScheduledRun) { publish({ histories: { [taskId]: [value] }, tasks: [{ ...task, activeRunId: value.id }] }); }
async function render() { await act(async () => { renderer = TestRenderer.create(<ScheduledTasksWorkspace />); }); }
function runButton() { return renderer!.root.findAllByType('Pressable').find((node: { props: { testID?: string } }) => node.props.testID === 'scheduled-task-run-now')!; }
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); mocks.focused = true; mocks.params.taskId = taskId; mocks.params.runId = undefined;
    mocks.snapshot = { tasks: [{ ...task }], loading: false, error: null, revision: 1, accountGeneration: 1, histories: { [taskId]: [] } };
    mocks.runNow.mockImplementation(async () => { const created = run(); stage(created); return created; });
});

describe('scheduled task audit', () => {
    const requestId = '00000000-0000-4000-8000-000000000003';
    const otherId = '00000000-0000-4000-8000-000000000004';
    const text = (node: { findAllByType(type: string): Array<{ props: { children: unknown } }> }) => node.findAllByType('Text')
        .map(child => Array.isArray(child.props.children) ? child.props.children.join('') : child.props.children).join('\n');

    it('shows a prior fixed-program delivery, without opening or inventing a conversation', async () => {
        mocks.params.runId = runId;
        stage(run({ executionKind: 'local-handler', webhookRequestId: requestId, status: 'completed', startedAt: 10, finishedAt: 20 }));
        mocks.snapshot.tasks = [{ ...task, enabled: false, executionKind: 'local-handler' }];
        await render();
        const detail = renderer!.root.findAllByProps({ testID: `scheduled-run-audit-${runId}` })[0];
        expect(text(detail)).toContain('scheduledTasks.audit.webhook');
        expect(text(detail)).toContain('scheduledTasks.audit.legacy');
        expect(text(detail)).toContain(requestId);
        expect(text(renderer!.root)).toContain('scheduledTasks.audit.timePlanOff');
        expect(renderer!.root.findAllByProps({ testID: 'scheduled-run-open-result' })).toHaveLength(0);
        expect(mocks.push).not.toHaveBeenCalled();
    });

    it('keeps the selected run open while new events arrive and renders its persisted sequence', async () => {
        const first = run({ trigger: 'schedule', audit: [{ at: 1, status: 'pending', reason: null }] });
        const other = run({ id: otherId, trigger: 'manual' });
        stage(first);
        await render();
        const inspect = renderer!.root.findAllByType('Pressable').find((node: { props: { testID?: string } }) => node.props.testID === `scheduled-run-inspect-${runId}`)!;
        await act(async () => inspect.props.onPress());
        expect(mocks.setParams).toHaveBeenCalledWith({ runId });
        const claimed = { ...first, status: 'claimed' as const, audit: [...first.audit!, { at: 2, status: 'claimed' as const, reason: null }] };
        await act(async () => publish({ histories: { [taskId]: [other, claimed] } }));
        const detail = renderer!.root.findAllByProps({ testID: `scheduled-run-audit-${runId}` })[0];
        const labels = text(detail);
        expect(labels).toMatch(/scheduledTasks\.audit\.received[\s\S]+scheduledTasks\.audit\.machineClaimed/);
        expect(labels).toContain('scheduledTasks.audit.schedule');
        expect(labels).not.toContain('scheduledTasks.audit.legacy');
        expect(renderer!.root.findAllByProps({ testID: `scheduled-run-audit-${otherId}` })).toHaveLength(0);
    });
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; mocks.listeners.clear(); });

describe('scheduled task launch intent', () => {
    it('blocks rapid repeat clicks, then opens only the session bound to the returned run', async () => {
        await render();
        await act(async () => { runButton().props.onPress(); runButton().props.onPress(); });
        expect(mocks.runNow).toHaveBeenCalledTimes(1); expect(runButton().props.disabled).toBe(true); expect(mocks.push).not.toHaveBeenCalled();
        const other = run({ id: '00000000-0000-4000-8000-000000000099', status: 'completed', sessionId: 'unrelated-session', finishedAt: Date.now() });
        await act(async () => publish({ histories: { [taskId]: [other, run({ status: 'claimed', sessionId: 'exact-session' })] } }));
        expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/session/exact-session');
    });
    it('cancels automatic navigation when the user leaves a waiting launch and returns later', async () => {
        await render(); await act(async () => runButton().props.onPress()); mocks.focused = false;
        await act(async () => renderer!.update(<ScheduledTasksWorkspace />));
        await act(async () => stage(run({ status: 'claimed', sessionId: 'background-session' })));
        mocks.focused = true; await act(async () => renderer!.update(<ScheduledTasksWorkspace />));
        expect(mocks.push).not.toHaveBeenCalled();
    });
    it('ignores a late run response after the account changes', async () => {
        let resolve!: (value: ScheduledRun) => void;
        mocks.runNow.mockImplementation(() => new Promise<ScheduledRun>(done => { resolve = done; }));
        await render(); await act(async () => runButton().props.onPress());
        await act(async () => publish({ tasks: [], histories: {}, accountGeneration: 2, revision: 0 }));
        await act(async () => resolve(run({ status: 'claimed', sessionId: 'previous-account-session' })));
        expect(mocks.push).not.toHaveBeenCalled();
    });
    it('shows a startup failure without waiting forever when no session could be created', async () => {
        mocks.runNow.mockImplementation(async () => { const failed = run({ status: 'failed', reason: 'processor-startup-failed', finishedAt: Date.now() }); stage(failed); return failed; });
        await render(); await act(async () => runButton().props.onPress()); expect(mocks.push).not.toHaveBeenCalled();
        const alerts = renderer!.root.findAllByProps({ accessibilityRole: 'alert' });
        expect(alerts.some((node: { props: { children?: React.ReactNode } }) => node.props.children === 'scheduledTasks.startupFailed')).toBe(true);
        expect(runButton().props.accessibilityLabel).toBe('scheduledTasks.runNow');
    });
});
