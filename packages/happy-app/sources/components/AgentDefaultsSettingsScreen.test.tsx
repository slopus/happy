import * as React from 'react';
import { act } from 'react';
// @ts-expect-error renderer declarations are not installed
import TestRenderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentDefaultsSettingsScreen from '@/app/(app)/settings/agents';

const mocks = vi.hoisted(() => ({ overrides: {} as any, save: vi.fn(), reconcile: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { header: { tint: '#fff' } } } }) }));
vi.mock('@/components/Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ItemList', () => ({ ItemList: (props: any) => React.createElement('ItemList', props, props.children) }));
vi.mock('@/hooks/useNewSessionDraft', () => ({ useNewSessionDraft: { getState: () => ({ reconcileCodexDefaults: mocks.reconcile }) } }));
vi.mock('@/sync/storage', () => ({ useSettingMutable: () => [mocks.overrides, mocks.save] }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

beforeEach(() => { vi.clearAllMocks(); mocks.overrides = { codex: { permissionMode: 'safe-yolo' } }; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
describe('Agent permission defaults', () => {
    it('shows the unavailable stored policy without offering it or rewriting the override', async () => {
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<AgentDefaultsSettingsScreen />); });
        const group = renderer.root.findByProps({ title: 'Codex' });
        const field = group.findAllByType('Item').find((item: any) => item.props.title === 'agentDefaults.fieldPermission');
        expect(field.props.detail).toContain('agentInput.taskPermission.unavailable');
        act(() => field.props.onPress());
        expect(group.findAllByType('Item').some((item: any) => item.props.title === 'agentInput.taskPermission.automatic')).toBe(false);
        expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.overrides.codex.permissionMode).toBe('safe-yolo');
        const confirm = group.findAllByType('Item').find((item: any) => item.props.title === 'agentInput.taskPermission.confirm');
        act(() => confirm.props.onPress());
        expect(mocks.save).toHaveBeenCalledWith({ codex: { permissionMode: 'acceptEdits' } });
        act(() => renderer.unmount());
    });
});
