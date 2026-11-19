import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error test renderer is supplied by the workspace.
import TestRenderer from 'react-test-renderer';
const mocks = vi.hoisted(() => ({
    configured: {} as Record<string, string[]>, inspect: vi.fn(), update: vi.fn(), online: true,
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', Switch: 'Switch', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ machineId: 'm1' }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }), StyleSheet: { hairlineWidth: 1, create: (fn: any) => fn({ colors: {} }) } }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('./CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('./codingAgentOps', () => ({ inspectCodingAgents: mocks.inspect, updateCodingAgent: mocks.update }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => mocks.online }));
vi.mock('@/hooks/useNewSessionDraft', () => ({ useNewSessionDraft: (selector: any) => selector({ selectedMachineId: 'm1' }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', async () => {
    const React = await import('react');
    const machines = [{ id: 'm1', metadata: { displayName: 'Mac', cliAvailability: { codex: true, claude: true } } }];
    return {
        useAllMachines: () => machines,
        storage: { getState: () => ({ settings: { codingAgentMachines: mocks.configured } }) },
        useSettingMutable: () => {
            const [value, setValue] = React.useState(mocks.configured);
            return [value, (next: Record<string, string[]>) => { mocks.configured = next; setValue(next); }];
        },
    };
});
import CodingAgentsSettings from './CodingAgentsSettings';
const agent = { id: 'claude', installed: true, executable: '/cli/claude', version: '1.0.0', latestVersion: '1.1.0', source: 'npm', reason: 'update-available', updateToken: '00000000-0000-4000-8000-000000000001' };
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.configured = {}; mocks.online = true; vi.clearAllMocks();
    mocks.inspect.mockResolvedValue({ agents: [agent], checkedAt: 1 });
});
describe('coding agent settings', () => {
    it('detects without checking remote versions, and explicitly saves per-machine enabled agents', async () => {
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<CodingAgentsSettings />); });
        expect(mocks.inspect).toHaveBeenCalledWith('m1', false);
        const enabled = (id: string) => renderer.root.findByProps({ testID: `coding-agent-enable-${id}` });
        expect(enabled('codex').props.value).toBe(true);
        expect(enabled('claude').props.value).toBe(false);
        expect(enabled('opencode').props.disabled).toBe(true);
        mocks.configured.m2 = ['opencode'];
        act(() => enabled('claude').props.onValueChange(true));
        expect(mocks.configured).toEqual({ m1: ['codex', 'claude'], m2: ['opencode'] });
        act(() => enabled('codex').props.onValueChange(false));
        act(() => enabled('claude').props.onValueChange(false));
        expect(mocks.configured.m1).toEqual([]);
        act(() => renderer.unmount());
    });
    it('checks on click, performs one update and consumes its token', async () => {
        let renderer: any;
        mocks.update.mockResolvedValue({ success: true, reason: 'updated', agent: { ...agent, version: '1.1.0', updateToken: undefined } });
        await act(async () => { renderer = TestRenderer.create(<CodingAgentsSettings />); });
        await act(async () => renderer.root.findByProps({ testID: 'coding-agents-check' }).props.onPress());
        expect(mocks.inspect).toHaveBeenLastCalledWith('m1', true);
        const button = renderer.root.findByProps({ accessibilityLabel: 'codingAgents.update Claude Code' });
        await act(async () => { button.props.onPress(); button.props.onPress(); });
        expect(mocks.update).toHaveBeenCalledOnce();
        expect(mocks.update).toHaveBeenCalledWith('m1', 'claude', agent.updateToken);
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'codingAgents.update Claude Code' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
    it('shows an old-daemon error without changing enabled settings', async () => {
        mocks.inspect.mockRejectedValue(new Error('RPC method not available'));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<CodingAgentsSettings />); });
        expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe('codingAgents.unavailable');
        expect(mocks.configured).toEqual({});
        act(() => renderer.unmount());
    });
});
