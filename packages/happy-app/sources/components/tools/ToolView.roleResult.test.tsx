import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ push: vi.fn(), header: vi.fn(), themes: null as any, theme: null as any }));
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    Pressable: 'Pressable', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
}));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await vi.importActual<typeof import('@/themePacks')>('@/themePacks');
    mocks.themes = appThemes; mocks.theme = appThemes.caramelLight;
    return { StyleSheet: { create: (factory: any) => new Proxy({}, {
        get: (_, key) => (typeof factory === 'function' ? factory(mocks.theme) : factory)[key],
    }) }, useUnistyles: () => ({ theme: mocks.theme }) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 1 }));
vi.mock('@/hooks/useOpenSessionFile', () => ({ useOpenSessionFile: () => vi.fn() }));
vi.mock('@/utils/toolDisplay', () => ({
    getTerminalToolCommand: () => null, isInlineAudioFileTool: () => false,
    isInlineImageFileTool: () => false, isInlineVideoFileTool: () => false, shouldRenderToolCardHeader: () => true,
}));
vi.mock('./views/_all', () => ({ getToolViewComponent: () => null }));
vi.mock('./views/MCPToolView', () => ({ formatMCPTitle: () => 'Manage roles' }));
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/utils/toolErrorParser', () => ({ parseToolUseError: () => ({ isToolUseError: false }) }));
vi.mock('./PermissionFooter', () => ({ PermissionFooter: () => null }));
vi.mock('./ToolError', () => ({ ToolError: 'ToolError' }));
vi.mock('../CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('./ToolSectionView', () => ({ ToolSectionView: 'ToolSectionView' }));
vi.mock('./McpAppHost', () => ({ McpAppHost: 'McpAppHost' }));

import { ToolView } from './ToolView';
import { TranscriptReadOnlyContext } from '../TranscriptReadOnlyContext';
import type { ToolCall } from '@/sync/typesMessage';

const role = { id: 'writer-id', name: 'Technical writer', description: 'Write technical articles', agent: 'antigravity',
    model: 'gemini-neon', autoDelegate: false, createdAt: 1, updatedAt: 2 };
const baseTool: ToolCall = { name: 'mcp__happy__agent_roles', state: 'completed',
    input: { action: 'create', role: { id: role.id } },
    result: { content: [{ type: 'text', text: JSON.stringify({ success: true, role, roles: [role] }) }] },
    createdAt: 1, startedAt: 1, completedAt: 2, description: null };

describe('ToolView saved-role receipt', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.clearAllMocks(); mocks.theme = mocks.themes.caramelLight;
    });

    it('shows the compact actual role under an otherwise minimal MCP call and opens its precise machine/ID', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ToolView metadata={{ machineId: 'actual-machine' } as any}
            tool={baseTool} sessionId="session" messageId="message" onPress={mocks.header} />); });
        const receipt = renderer.root.findByProps({ testID: 'agent-role-result' });
        expect(renderer.root.findAllByType('Text').some((node: any) => node.children.join('') === 'delegation.saved')).toBe(true);
        expect(receipt.findByType('CodingAgentIcon').props.agent).toBe('antigravity');
        expect(receipt.findAllByType('Text').map((node: any) => node.children.join('')).join(' ')).toContain('writer-id');
        const stopPropagation = vi.fn();
        act(() => renderer.root.findByProps({ testID: 'agent-role-view' }).props.onPress({ stopPropagation }));
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(mocks.header).not.toHaveBeenCalled();
        expect(mocks.push).toHaveBeenCalledWith({ pathname: '/settings/delegation-roles', params: { machineId: 'actual-machine', roleId: 'writer-id' } });
        act(() => renderer.unmount());
    });

    it('keeps the saved receipt inert in a read-only transcript or without a source machine', () => {
        for (const [readOnly, machineId] of [[true, 'actual-machine'], [false, undefined]] as const) {
            let renderer: any;
            act(() => { renderer = TestRenderer.create(<TranscriptReadOnlyContext.Provider value={readOnly}>
                <ToolView metadata={machineId ? { machineId } as any : null} tool={baseTool} />
            </TranscriptReadOnlyContext.Provider>); });
            expect(renderer.root.findAllByProps({ testID: 'agent-role-result' })).toHaveLength(1);
            expect(renderer.root.findAllByProps({ testID: 'agent-role-view' })).toHaveLength(0);
            expect(mocks.push).not.toHaveBeenCalled();
            act(() => renderer.unmount());
        }
    });

    it.each([
        { ...baseTool, state: 'running' as const },
        { ...baseTool, state: 'error' as const },
        { ...baseTool, input: { action: 'list' } },
        { ...baseTool, result: { success: false, role } },
    ])('keeps failed or non-mutation MCP calls in the existing minimal layout', tool => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ToolView metadata={null} tool={tool} />); });
        expect(renderer.root.findAllByProps({ testID: 'tool-card-header' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'agent-role-result' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('uses current light and gingham dark semantic surfaces for ordinary, pressed and focused actions', () => {
        for (const name of ['caramelLight', 'ginghamDark'] as const) {
            mocks.theme = mocks.themes[name];
            let renderer: any;
            act(() => { renderer = TestRenderer.create(<ToolView metadata={{ machineId: 'actual-machine' } as any} tool={baseTool} />); });
            let action = renderer.root.findByProps({ testID: 'agent-role-view' });
            const flattened = (state: any) => Object.assign({}, ...action.props.style(state).filter(Boolean));
            expect(flattened({ pressed: false }).backgroundColor).toBe(mocks.theme.colors.surface);
            expect(flattened({ pressed: true }).backgroundColor).toBe(mocks.theme.colors.surfacePressed);
            expect(flattened({ pressed: false, hovered: true }).backgroundColor).toBe(mocks.theme.colors.surfacePressed);
            act(() => action.props.onFocus());
            action = renderer.root.findByProps({ testID: 'agent-role-view' });
            expect(flattened({ pressed: false }).borderColor).toBe(mocks.theme.colors.textLink);
            act(() => renderer.unmount());
        }
    });
});
