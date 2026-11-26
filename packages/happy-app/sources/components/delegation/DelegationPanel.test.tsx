import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegatedTask, DelegationRole } from '@slopus/happy-wire';
import { DelegatedTaskGroup, DelegationInspectorPanel } from './DelegationPanel';
import { SubagentInspectorProvider, useSubagentInspector, type SubagentInspectorContextValue, type SubagentInspectorSelection } from '../subagent/SubagentInspectorContext';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    session: { metadata: {} } as any,
    list: vi.fn(), save: vi.fn(), remove: vi.fn(), read: vi.fn(), cancel: vi.fn(), compose: vi.fn(),
}));
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Switch: 'Switch',
    Text: 'Text', TextInput: 'TextInput', View: 'View', Platform: { OS: 'web' },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'new-role-id' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory({ colors: {
        divider: 'divider', text: 'text', textLink: 'link', textSecondary: 'secondary', textDestructive: 'error',
        surfaceHigh: 'high', surface: 'surface', surfacePressed: 'pressed', surfaceSelected: 'selected',
    } }) },
    useUnistyles: () => ({ theme: { colors: { text: 'text', textLink: 'link', textSecondary: 'secondary' } } }),
}));
vi.mock('@/text', () => ({ t: (key: string, params?: unknown) => params ? `${key}:${JSON.stringify(params)}` : key }));
vi.mock('@/modal', () => ({ Modal: { confirm: async () => true } }));
vi.mock('@/sync/storage', () => ({ useSession: () => mocks.session, useMachine: () => null }));
vi.mock('@/sync/apiDelegation', () => ({
    listDelegationRoles: mocks.list, saveDelegationRole: mocks.save, deleteDelegationRole: mocks.remove,
    readDelegatedTask: mocks.read, cancelDelegatedTask: mocks.cancel,
}));
vi.mock('../RightSwipePanelHost', () => ({ useRightSwipePanel: () => null }));
vi.mock('../codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('../subagent/SubagentActivityGroup', () => ({ SubagentActivityGroup: 'SubagentActivityGroup' }));
vi.mock('../DesktopReadingWidth', () => ({ useDesktopReadingWidth: () => 960 }));

const role: DelegationRole = { id: 'writer', name: 'Writer', description: 'Write clear documentation', agent: 'antigravity', model: 'recorded-model',
    autoDelegate: true, createdAt: 1, updatedAt: 2 };
const task: DelegatedTask = { id: 'task-a', parentSessionId: 'parent-a', title: 'Write the README', roleId: role.id, roleName: role.name,
    agent: role.agent, model: role.model, version: 3, status: 'completed', startedAt: 1, updatedAt: 30, finishedAt: 30,
    prompt: 'Make it shorter', history: [{ version: 1, prompt: 'Write a README', status: 'completed', startedAt: 1, updatedAt: 10, result: { text: 'First result' } }],
    result: { text: 'Third result', truncated: true }, resultAvailable: true };
const roleSelection: SubagentInspectorSelection = { kind: 'agent-roles', id: 'agent-roles', roleId: role.id, title: 'Assistants', status: 'completed' };
const taskSelection: SubagentInspectorSelection = { kind: 'delegated-task', id: task.id, title: task.title, status: 'completed' };

describe('real delegation panels', () => {
    let renderer: any;
    let inspector: SubagentInspectorContextValue;
    function Probe() { inspector = useSubagentInspector()!; return null; }
    const element = (selection: SubagentInspectorSelection, sessionId = 'parent-a') => <SubagentInspectorProvider sessionId={sessionId}>
        <Probe /><DelegationInspectorPanel sessionId={sessionId} selection={selection} onBack={() => {}} onCompose={mocks.compose} />
    </SubagentInspectorProvider>;
    const render = async (selection: SubagentInspectorSelection) => {
        await act(async () => { renderer = TestRenderer.create(element(selection)); });
    };
    const button = (testID: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === testID);
    const press = async (testID: string) => { await act(async () => { button(testID).props.onPress(); }); };
    const input = (testID: string) => renderer.root.findAllByType('TextInput').find((node: any) => node.props.testID === testID);
    const textContent = () => renderer.root.findAllByType('Text').map((node: any) => node.children.join(''));

    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        vi.clearAllMocks();
        mocks.session = { metadata: { flavor: 'codex', capabilities: { delegation: 1 }, delegationRoles: [role], delegatedTasks: [task] } };
        mocks.list.mockResolvedValue([role]); mocks.read.mockResolvedValue(task);
        mocks.save.mockResolvedValue({ ...role, updatedAt: 3 }); mocks.remove.mockResolvedValue([]);
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });

    it('preserves unsaved fields after a rejected save and only updates roles after acknowledgement', async () => {
        await render(roleSelection);
        inspector!.roleDrafts!.current.set('new', { id: 'other-draft', name: 'Keep this new role', description: 'Unrelated unsaved role', agent: 'codex', model: 'another-model', autoDelegate: false });
        act(() => input('delegation-role-name').props.onChangeText('Edited writer'));
        mocks.save.mockRejectedValueOnce(new Error('Model unavailable'));
        await press('delegation-role-save');
        expect(input('delegation-role-name').props.value).toBe('Edited writer');
        expect(inspector!.roleDrafts!.current.get(role.id)?.name).toBe('Edited writer');
        expect(renderer.root.findByProps({ testID: 'delegation-role-error' }).children.join('')).toBe('Model unavailable');
        expect(renderer.root.findAllByProps({ testID: 'delegation-role-saved' })).toHaveLength(0);
        expect(inspector!.delegationRoles?.[0].name).toBe('Writer');
        mocks.save.mockResolvedValueOnce({ ...role, name: 'Edited writer', updatedAt: 4 });
        await press('delegation-role-save');
        expect(inspector!.delegationRoles?.[0].name).toBe('Edited writer');
        expect(inspector!.roleDrafts!.current.get('new')?.name).toBe('Keep this new role');
        expect(mocks.session.metadata.delegatedTasks[0].model).toBe('recorded-model');
        expect(button('delegation-role-use').props.disabled).toBe(false);
        await press('delegation-role-use');
        expect(mocks.compose).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"id":"writer"'));
        expect(mocks.read).not.toHaveBeenCalled();
    });

    it('uses real version numbers and appends through the composer without executing a task', async () => {
        await render(taskSelection);
        await press('delegation-result-tab');
        expect(button('delegation-version-1')).toBeDefined();
        expect(button('delegation-version-3')).toBeDefined();
        expect(button('delegation-version-2')).toBeUndefined();
        expect(renderer.root.findByProps({ testID: 'delegation-result-text' }).children.join('')).toBe('Third result');
        await press('delegation-version-1');
        expect(renderer.root.findByProps({ testID: 'delegation-result-text' }).children.join('')).toBe('First result');
        expect(inspector!.taskViews!.current.get(task.id)).toEqual({ tab: 'result', version: 1 });
        await press('delegation-task-append');
        expect(mocks.compose).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"id":"task-a"'));
        expect(mocks.read).toHaveBeenCalledTimes(1);
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it('reads once per opening and waits for explicit refresh after metadata changes', async () => {
        await render(taskSelection);
        mocks.session = { metadata: { ...mocks.session.metadata, delegatedTasks: [{ ...task, version: 4, updatedAt: 40, status: 'running' }] } };
        act(() => renderer.update(element(taskSelection)));
        expect(mocks.read).toHaveBeenCalledTimes(1);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.children.join('') === 'delegation.updateAvailable')).toBe(true);
        await press('delegation-task-refresh');
        expect(mocks.read).toHaveBeenCalledTimes(2);
    });

    it('opens a continuation source task read-only without composing into the new parent', async () => {
        await act(async () => { renderer = TestRenderer.create(element({ ...taskSelection, parentSessionId: 'parent-a' }, 'new-parent')); });
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith('parent-a', task.id);
        expect(button('delegation-task-append').props.disabled).toBe(true);
        await press('delegation-task-append');
        expect(mocks.compose).not.toHaveBeenCalled();
    });

    it('opens an anchored task with its source parent and excludes foreign summaries', async () => {
        await act(async () => { renderer = TestRenderer.create(<SubagentInspectorProvider sessionId="new-parent"><Probe />
            <DelegatedTaskGroup sessionId="parent-a" tasks={[task, { ...task, id: 'foreign', parentSessionId: 'other' }]} />
        </SubagentInspectorProvider>); });
        const group = renderer.root.findByType('SubagentActivityGroup');
        expect(group.props.activities.map((activity: any) => activity.id)).toEqual([task.id]);
        act(() => group.props.onOpen(group.props.activities[0]));
        expect(inspector!.selection).toMatchObject({ kind: 'delegated-task', id: task.id, parentSessionId: 'parent-a' });
    });

    it('keeps handoff context scoped to the selected version, including an absent historical context', async () => {
        const versionedTask = { ...task, version: 4, context: 'Fourth handoff', history: [
            ...task.history,
            { version: 2, prompt: 'Revise the README', context: 'Second handoff', status: 'completed' as const, startedAt: 11, updatedAt: 20 },
        ] };
        mocks.session.metadata.delegatedTasks = [versionedTask];
        mocks.read.mockResolvedValueOnce(versionedTask);
        await render(taskSelection);
        await press('delegation-result-tab');
        await press('delegation-version-1');
        await press('delegation-context-tab');
        expect(textContent()).toContain('Write a README');
        expect(textContent()).toContain('delegation.noContext');
        expect(textContent()).not.toContain('Fourth handoff');
        await press('delegation-result-tab');
        await press('delegation-version-2');
        await press('delegation-context-tab');
        expect(textContent()).toContain('Second handoff');
        expect(textContent()).not.toContain('Fourth handoff');
        await press('delegation-result-tab');
        await press('delegation-version-4');
        await press('delegation-context-tab');
        expect(textContent()).toContain('Fourth handoff');
    });

    it('requires the current parent worker capability for composer dispatch', async () => {
        mocks.session.metadata.capabilities = {};
        mocks.session.metadata.delegationProtocol = 1;
        await render(roleSelection);
        expect(button('delegation-role-use').props.disabled).toBe(true);
        expect(button('delegation-role-save').props.disabled).toBe(true);
        expect(button('delegation-role-delete').props.disabled).toBe(true);
        expect(button('delegation-roles-refresh').props.disabled).toBe(true);
        await press('delegation-role-save');
        await press('delegation-role-delete');
        await press('delegation-roles-refresh');
        expect(mocks.list).not.toHaveBeenCalled();
        expect(mocks.save).not.toHaveBeenCalled();
        expect(mocks.remove).not.toHaveBeenCalled();
        await act(async () => renderer.update(element(taskSelection)));
        expect(button('delegation-task-append').props.disabled).toBe(true);
        await press('delegation-result-tab');
        expect(renderer.root.findByProps({ testID: 'delegation-result-text' }).children.join('')).toBe('Third result');
        expect(mocks.compose).not.toHaveBeenCalled();
    });

    it('keeps a published running task inspectable while disabling cancellation and append without a worker capability', async () => {
        const running = { ...task, status: 'running' as const, finishedAt: undefined };
        mocks.session.metadata = { ...mocks.session.metadata, capabilities: {}, delegationProtocol: 1, delegatedTasks: [running] };
        mocks.read.mockResolvedValueOnce(running);
        await render(taskSelection);
        await press('delegation-result-tab');
        expect(renderer.root.findByProps({ testID: 'delegation-result-text' }).children.join('')).toBe('Third result');
        expect(button('delegation-task-append').props.disabled).toBe(true);
        expect(button('delegation-task-cancel').props.disabled).toBe(true);
        await press('delegation-task-cancel');
        expect(mocks.read).toHaveBeenCalledTimes(1);
        expect(mocks.cancel).not.toHaveBeenCalled();
        expect(mocks.compose).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'completed', 'failed', 'interrupted'] as const)('clears the pending cancellation notice when the daemon confirms %s, even with the retained request marker', async terminalStatus => {
        const running = { ...task, status: 'running' as const, updatedAt: 20, finishedAt: undefined };
        mocks.session.metadata.delegatedTasks = [running];
        mocks.read.mockResolvedValueOnce(running);
        mocks.cancel.mockResolvedValueOnce({ ...running, cancelRequested: true, updatedAt: 21 });
        await render(taskSelection);
        await press('delegation-task-cancel');
        expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('parent-a', task.id);
        expect(renderer.root.findByProps({ testID: 'delegation-task-status' }).children.join('')).toBe('delegation.running');
        expect(button('delegation-task-cancel').props.disabled).toBe(true);
        expect(textContent()).toContain('delegation.cancelRequested');
        const terminal = { ...running, status: terminalStatus, cancelRequested: true, updatedAt: 22 };
        mocks.session = { metadata: { ...mocks.session.metadata, delegatedTasks: [terminal] } };
        act(() => renderer.update(element(taskSelection)));
        expect(renderer.root.findByProps({ testID: 'delegation-task-status' }).children.join('')).toBe(`delegation.${terminalStatus}`);
        expect(textContent()).not.toContain('delegation.cancelRequested');
        mocks.read.mockResolvedValueOnce(terminal);
        await press('delegation-task-refresh');
        expect(renderer.root.findByProps({ testID: 'delegation-task-status' }).children.join('')).toBe(`delegation.${terminalStatus}`);
        expect(textContent()).not.toContain('delegation.cancelRequested');
        expect(button('delegation-task-cancel')).toBeUndefined();
    });

    it('deletes an acknowledged role without rewriting any task route snapshots', async () => {
        await render(roleSelection);
        await press('delegation-role-delete');
        expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('parent-a', role.id);
        expect(inspector!.delegationRoles).toEqual([]);
        expect(input('delegation-role-name').props.value).toBe('');
        expect(mocks.session.metadata.delegatedTasks[0]).toEqual(task);
    });
});
