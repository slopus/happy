import { setFirstSubmissionScope, getFirstSubmissionScope } from '@/sync/firstSubmissionScope';
vi.mock('@/sync/roleConfigurationHandoff', () => ({ recordRoleConfigurationSavedResult: vi.fn() }));
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { ConversationTranscript } from './ConversationTranscript';
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import type { Message } from '@/sync/typesMessage';
import { SubagentInspectorProvider, useSubagentInspector, type SubagentInspectorContextValue } from './subagent/SubagentInspectorContext';

// Exercise normalization, reduction, both real grouping layers, MessageView,
// ToolView and the actual saved-role result. Only platform/infrastructure and
// unrelated transcript content are replaced.
const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: vi.fn() }) },
    ActivityIndicator: 'ActivityIndicator',
    FlatList: (props: any) => <>{props.data.map((item: any) =>
        <React.Fragment key={props.keyExtractor(item)}>{props.renderItem({ item })}</React.Fragment>)}</>,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    Pressable: 'Pressable', TouchableOpacity: 'TouchableOpacity', Text: 'Text', View: 'View', TextInput: 'TextInput', ScrollView: 'ScrollView',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));
vi.mock('@/realtime/RealtimeSession', () => ({ RealtimeSession: {} }));
vi.mock('react-native-device-info', () => ({ getDeviceType: () => 'Desktop' }));
vi.mock('@expo/vector-icons', () => ({ Octicons: 'Octicons', Ionicons: 'Ionicons' }));
vi.mock('./codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('react-native-reanimated', () => ({ default: { View: 'AnimatedView' }, FadeIn: { duration: vi.fn() }, FadeOut: { duration: vi.fn() } }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await vi.importActual<typeof import('@/themePacks')>('@/themePacks');
    const theme = appThemes.ginghamDark;
    return { StyleSheet: { create: (factory: any) => typeof factory === 'function' ? factory(theme) : factory }, useUnistyles: () => ({ theme }) };
});
vi.mock('@/navigation/desktopModalRouter', () => ({ getDesktopModalBackgroundPath: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/modal/components/BaseModal', () => ({ BaseModal: 'BaseModal' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 0 }));
vi.mock('@/hooks/useOpenSessionFile', () => ({ useOpenSessionFile: () => vi.fn() }));
vi.mock('@/utils/messageForkPoint', () => ({ getAgentMessageForkTargets: () => new Map(), getUserMessageForkRewindPointId: () => undefined }));
vi.mock('./tools/knownTools', () => ({ knownTools: {} }));
vi.mock('./tools/views/_all', () => ({ getToolViewComponent: () => null }));
vi.mock('./tools/views/MCPToolView', () => ({ formatMCPTitle: (name: string) => name }));
vi.mock('./tools/PermissionFooter', () => ({ PermissionFooter: () => null }));
vi.mock('./tools/ToolError', () => ({ ToolError: 'ToolError' }));
vi.mock('./CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('./tools/ToolSectionView', () => ({ ToolSectionView: 'ToolSectionView' }));
vi.mock('./tools/McpAppHost', () => ({ McpAppHost: 'McpAppHost' }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'DesktopShortcutTooltip' }));
vi.mock('./AttachmentGalleryView', () => ({ AttachmentGalleryView: 'AttachmentGalleryView' }));
vi.mock('./AnchorListSheet', () => ({ AnchorListSheet: 'AnchorListSheet' }));
vi.mock('./rightPanel/BrowserStepsPopover', () => ({ BrowserStepsPopover: 'BrowserStepsPopover' }));
vi.mock('./haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));

const role = { id: 'writer-id', name: 'Technical writer', description: 'Write README', agent: 'antigravity',
    model: 'neon', effort: 'high', autoDelegate: false, createdAt: 1, updatedAt: 2 };
function nativeConversation(): Message[] {
    const envelopes = [{ id: 'list-start', time: 1000, role: 'agent', turn: 'role-turn', ev: {
        t: 'tool-call-start', call: 'role-list', name: 'McpTool', title: 'happy.agent_roles', description: 'List roles', args: { server: 'happy', tool: 'agent_roles', arguments: { action: 'list' } },
    } }, { id: 'list-end', time: 1100, role: 'agent', turn: 'role-turn', ev: {
        t: 'tool-call-end', call: 'role-list', status: 'completed',
    } }, { id: 'save-start', time: 1200, role: 'agent', turn: 'role-turn', ev: {
        t: 'tool-call-start', call: 'role-save', name: 'McpTool', title: 'happy.agent_roles', description: 'Save role', args: { server: 'happy', tool: 'agent_roles', arguments: { action: 'update', roleId: role.id, patch: { name: role.name } } },
    } }, { id: 'save-end', time: 1300, role: 'agent', turn: 'role-turn', ev: {
        t: 'tool-call-end', call: 'role-save', status: 'completed', mcpAppResult: { version: 1, state: 'available', content: [], structuredContent: { success: true, role } },
    } }];
    const normalized = envelopes.map((content, i) => normalizeRawMessage(`role-db-${i}`, null, content.time,
        { role: 'session', content } as any)).filter((message): message is NormalizedMessage => message !== null);
    return [{ kind: 'agent-text', id: 'final', localId: null, createdAt: 1400, text: 'Saved.' },
        ...reducer(createReducer(), normalized).messages.sort((a, b) => b.createdAt - a.createdAt)];
}

describe('saved role result through the real transcript', () => {
    let renderer: any;
    let inspector: SubagentInspectorContextValue;
    function Probe() { inspector = useSubagentInspector()!; return null; }
    beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); setFirstSubmissionScope('owner-a', 'https://test'); });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });
    const byId = (testID: string) => renderer.root.find((node: any) => node.type === 'Pressable' && node.props.testID === testID);

    it.each([true, false])('shows the verified native save action without opening work/tool groups, grouping=%s', async groupToolCalls => {
        await act(async () => { renderer = TestRenderer.create(<SubagentInspectorProvider sessionId="config-session"><Probe /><ConversationTranscript sessionId="config-session"
            metadata={{ machineId: 'role-machine', flavor: 'codex' } as any} messages={nativeConversation()} groupToolCalls={groupToolCalls} /></SubagentInspectorProvider>); });
        expect(renderer.root.findAllByProps({ testID: 'agent-role-result' })).toHaveLength(1);
        expect(byId('agent-role-view').props.accessibilityLabel).toBe('delegation.viewRole');
        const stopPropagation = vi.fn();
        act(() => byId('agent-role-view').props.onPress({ stopPropagation }));
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(mocks.push).not.toHaveBeenCalled();
        expect(inspector!.selection).toMatchObject({ kind: 'role-detail', machineId: 'role-machine', roleId: role.id, savedRole: role });
        if (groupToolCalls) {
            expect(byId('conversation-agent-work-toggle').props.accessibilityState.expanded).toBe(false);
            act(() => byId('conversation-agent-work-toggle').props.onPress());
            expect(byId('conversation-tool-group-toggle').props.accessibilityState.expanded).toBe(false);
            expect(renderer.root.findAllByProps({ testID: 'agent-role-result' })).toHaveLength(1);
            act(() => byId('conversation-tool-group-toggle').props.onPress());
            expect(renderer.root.findAllByProps({ testID: 'agent-role-result' })).toHaveLength(1);
        }
    });
});
