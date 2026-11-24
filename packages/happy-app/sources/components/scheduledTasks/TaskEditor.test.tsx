// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskEditor } from './TaskEditor';
import { ScheduleChoice } from './ScheduleChoice';
import { DesktopDialogFrame } from '@/components/DesktopDialogFrame';
import type { DecryptedScheduledTask } from '@/sync/scheduledTasks';

const mocks = vi.hoisted(() => ({ save: vi.fn(), confirm: vi.fn(), machines: [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '/work', host: 'Machine' } }] }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'web' } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: 'text', textSecondary: 'muted', divider: 'divider', input: { background: 'input' }, surface: 'surface', surfaceSelected: 'selected', surfacePressed: 'pressed', textDestructive: 'error' } };
    return { StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory(theme), hairlineWidth: 1 }, useUnistyles: () => ({ theme }) };
});
vi.mock('@/components/DesktopDialogFrame', () => ({ DesktopDialogFrame: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key === 'scheduledTasks.weekdaysShort' ? 'Sun Mon Tue Wed Thu Fri Sat' : key }));
vi.mock('@/sync/sync', () => ({ sync: { scheduledTasks: { save: mocks.save } } }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => mocks.machines, useAllSessions: () => [] }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/hooks/useCodexAccounts', () => ({ useCodexAccounts: () => ({ loading: false, error: null, bindings: [] }) }));
vi.mock('@/utils/newSessionModelMetadata', () => ({ getLatestSessionModelMetadata: () => null }));
vi.mock('@/components/modelModeOptions', () => ({ getSuggestedModelModes: () => [], getEffortLevelsForModel: () => [] }));

const renderers: ReturnType<typeof TestRenderer.create>[] = [];
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.save.mockReset().mockResolvedValue(undefined);
    mocks.confirm.mockReset().mockResolvedValue(true);
    mocks.machines = [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '/work', host: 'Machine' } }];
});
afterEach(async () => {
    await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); });
});
function task(config: Partial<NonNullable<DecryptedScheduledTask['config']>> = {}): DecryptedScheduledTask {
    return { id: '00000000-0000-4000-8000-000000000001', machineId: 'machine', rule: { type: 'daily', time: '09:00', timezone: 'UTC' },
        encryptedConfig: 'encrypted', enabled: true, newChatEachRun: false, notificationPolicy: 'none', version: 0, nextAt: 100, createdAt: 1, updatedAt: 1,
        activeRunId: null, bindingVersion: 0, conversationSessionId: null, config: { title: 'Original', prompt: 'Go', directory: '/work', agent: 'codex', permissionMode: 'read-only', ...config } };
}
async function renderEditor(props: React.ComponentProps<typeof TaskEditor>) {
    let renderer: ReturnType<typeof TestRenderer.create>;
    await act(async () => { renderer = TestRenderer.create(<TaskEditor {...props} />); });
    renderers.push(renderer!);
    return renderer!;
}
function field(renderer: ReturnType<typeof TestRenderer.create>, id: string) {
    return renderer.root.findAllByType('TextInput').find((input: { props: { testID?: string } }) => input.props.testID === id)!;
}
function choice(renderer: ReturnType<typeof TestRenderer.create>, id: string) {
    return renderer.root.findAllByType(ScheduleChoice).find((input: { props: { testID?: string } }) => input.props.testID === id)!;
}
function button(renderer: ReturnType<typeof TestRenderer.create>, id: string) {
    return renderer.root.findAllByType('Pressable').find((input: { props: { testID?: string } }) => input.props.testID === id)!;
}

it('keeps the editor version and enablement from when its draft was opened', async () => {
    const original = task();
    const renderer = await renderEditor({ task: original, onClose: () => {} });
    await act(async () => { field(renderer, 'scheduled-task-name').props.onChangeText('My draft'); });
    await act(async () => { renderer.update(<TaskEditor task={{ ...original, version: 4, enabled: false, config: { ...original.config!, title: 'Other device edit' } }} onClose={() => {}} />); });
    await act(async () => { button(renderer, 'scheduled-task-save').props.onPress(); });
    expect(mocks.save.mock.calls[0][2]).toBe(0);
    expect(mocks.save.mock.calls[0][0].enabled).toBe(true);
});

it('fills a late machine default without making the untouched draft dirty', async () => {
    mocks.machines = [];
    const closed = vi.fn();
    const renderer = await renderEditor({ onClose: closed });
    expect(choice(renderer, 'scheduled-task-machine').props.value).toBe('');
    expect(renderer.root.findAllByType('Text').some((node: { props: { children?: string } }) => node.props.children === 'scheduledTasks.upgradeRequired')).toBe(false);
    mocks.machines = [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '/work', host: 'Machine' } }];
    await act(async () => renderer.update(<TaskEditor onClose={() => closed()} />));
    expect(choice(renderer, 'scheduled-task-machine').props.value).toBe('machine');
    await act(async () => button(renderer, 'scheduled-task-advanced').props.onPress());
    expect(field(renderer, 'scheduled-task-directory').props.value).toBe('/work');
    await act(async () => renderer.root.findByType(DesktopDialogFrame).props.onClose());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
});

it('preserves text entered while the machine directory is loading', async () => {
    mocks.machines = [];
    const renderer = await renderEditor({ onClose: () => {} });
    await act(async () => field(renderer, 'scheduled-task-name').props.onChangeText('My new task'));
    mocks.machines = [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '/work', host: 'Machine' } }];
    await act(async () => renderer.update(<TaskEditor onClose={() => {}} />));
    expect(field(renderer, 'scheduled-task-name').props.value).toBe('My new task');
    expect(choice(renderer, 'scheduled-task-machine').props.value).toBe('machine');
});

it('fills machine metadata that arrives later without restoring an intentionally cleared directory', async () => {
    mocks.machines = [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '', host: 'Machine' } }];
    const renderer = await renderEditor({ onClose: () => {} });
    await act(async () => button(renderer, 'scheduled-task-advanced').props.onPress());
    expect(field(renderer, 'scheduled-task-directory').props.value).toBe('');
    mocks.machines = [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '/work', host: 'Machine' } }];
    await act(async () => renderer.update(<TaskEditor onClose={() => {}} />));
    expect(field(renderer, 'scheduled-task-directory').props.value).toBe('/work');
    await act(async () => field(renderer, 'scheduled-task-directory').props.onChangeText(''));
    expect(field(renderer, 'scheduled-task-directory').props.value).toBe('');
});

it('retains custom execution settings when the current machine, agent or model is selected again', async () => {
    const renderer = await renderEditor({ task: task({ directory: '/work/custom', model: 'pinned-model', effort: 'high' }), onClose: () => {} });
    // These common choices are available without expanding advanced settings.
    expect(choice(renderer, 'scheduled-task-permissions').props.value).toBe('read-only');
    await act(async () => {
        choice(renderer, 'scheduled-task-machine').props.onChange('machine');
        choice(renderer, 'scheduled-task-engine').props.onChange('codex');
        choice(renderer, 'scheduled-task-model').props.onChange('pinned-model');
        button(renderer, 'scheduled-task-advanced').props.onPress();
    });
    expect(field(renderer, 'scheduled-task-directory').props.value).toBe('/work/custom');
    expect(choice(renderer, 'scheduled-task-model').props.value).toBe('pinned-model');
    expect(choice(renderer, 'scheduled-task-effort').props.value).toBe('high');
});

it('submits once, protects the pending draft from closing, and reports the saved task before closing', async () => {
    let resolveSave!: () => void;
    mocks.save.mockReturnValue(new Promise<void>(resolve => { resolveSave = resolve; }));
    const events: string[] = [];
    const original = task();
    const renderer = await renderEditor({ task: original, onSaved: id => events.push(id), onClose: () => events.push('closed') });
    const save = button(renderer, 'scheduled-task-save').props.onPress;
    await act(async () => { save(); save(); });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(field(renderer, 'scheduled-task-name').props.editable).toBe(false);
    expect(choice(renderer, 'scheduled-task-machine').props.disabled).toBe(true);
    await act(async () => renderer.root.findByType(DesktopDialogFrame).props.onClose());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await act(async () => resolveSave());
    expect(events).toEqual([original.id, 'closed']);
});

it('asks once for concurrent close actions and preserves a declined draft', async () => {
    let resolveConfirm!: (answer: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise<boolean>(resolve => { resolveConfirm = resolve; }));
    const closed = vi.fn();
    const renderer = await renderEditor({ task: task(), onClose: closed });
    await act(async () => field(renderer, 'scheduled-task-name').props.onChangeText('Unsaved changes'));
    const close = renderer.root.findByType(DesktopDialogFrame).props.onClose;
    await act(async () => { close(); close(); });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    await act(async () => resolveConfirm(false));
    expect(closed).not.toHaveBeenCalled();
    expect(field(renderer, 'scheduled-task-name').props.value).toBe('Unsaved changes');
    await act(async () => close());
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledOnce();
});
