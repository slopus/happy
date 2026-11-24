// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { TaskEditor } from './TaskEditor';
import type { DecryptedScheduledTask } from '@/sync/scheduledTasks';

const mocks = vi.hoisted(() => ({ save: vi.fn().mockResolvedValue(undefined), machines: [{ id: 'machine', active: true, metadata: { scheduledTasks: 1, homeDir: '/work', host: 'Machine' } }] }));
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
vi.mock('@/modal', () => ({ Modal: { confirm: async () => true } }));
vi.mock('@/text', () => ({ t: (key: string) => key === 'scheduledTasks.weekdaysShort' ? 'Sun Mon Tue Wed Thu Fri Sat' : key }));
vi.mock('@/sync/sync', () => ({ sync: { scheduledTasks: { save: mocks.save } } }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => mocks.machines, useAllSessions: () => [] }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/hooks/useCodexAccounts', () => ({ useCodexAccounts: () => ({ loading: false, error: null, bindings: [] }) }));
vi.mock('@/utils/newSessionModelMetadata', () => ({ getLatestSessionModelMetadata: () => null }));
vi.mock('@/components/modelModeOptions', () => ({ getSuggestedModelModes: () => [], getEffortLevelsForModel: () => [] }));

it('keeps the editor version and enablement from when its draft was opened', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const original: DecryptedScheduledTask = { id: '00000000-0000-4000-8000-000000000001', machineId: 'machine', rule: { type: 'daily', time: '09:00', timezone: 'UTC' },
        encryptedConfig: 'encrypted', enabled: true, newChatEachRun: false, notificationPolicy: 'none', version: 0, nextAt: 100, createdAt: 1, updatedAt: 1,
        activeRunId: null, bindingVersion: 0, conversationSessionId: null, config: { title: 'Original', prompt: 'Go', directory: '/work', agent: 'codex', permissionMode: 'read-only' } };
    let renderer: ReturnType<typeof TestRenderer.create>;
    await act(async () => { renderer = TestRenderer.create(<TaskEditor task={original} onClose={() => {}} />); });
    await act(async () => { renderer!.root.findAllByType('TextInput').find((input: { props: { testID?: string } }) => input.props.testID === 'scheduled-task-name')!.props.onChangeText('My draft'); });
    await act(async () => { renderer!.update(<TaskEditor task={{ ...original, version: 4, enabled: false, config: { ...original.config!, title: 'Other device edit' } }} onClose={() => {}} />); });
    await act(async () => { await renderer!.root.findByProps({ testID: 'scheduled-task-save' }).props.onPress(); });
    expect(mocks.save.mock.calls[0][2]).toBe(0);
    expect(mocks.save.mock.calls[0][0].enabled).toBe(true);
    await act(async () => renderer!.unmount());
});
