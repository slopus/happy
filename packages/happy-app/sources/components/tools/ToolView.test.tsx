import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { ToolView } from './ToolView';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'android', select: (values: Record<string, unknown>) => values.android ?? values.default },
    Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
}));
vi.mock('react-native-unistyles', () => {
    const theme: Record<string, any> = { colors: { surfaceHigh: '#111', surfaceHighest: '#222', text: '#fff', textSecondary: '#aaa', warning: '#f90' } };
    return {
        StyleSheet: { create: (factory: unknown) => typeof factory === 'function' ? (factory as (value: typeof theme) => object)(theme) : factory },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 1 }));
vi.mock('@/utils/toolDisplay', () => ({
    getTerminalToolCommand: () => null,
    isInlineImageFileTool: () => false,
    isInlineVideoFileTool: () => false,
    shouldRenderToolCardHeader: () => true,
}));
vi.mock('./views/_all', () => ({ getToolViewComponent: () => null }));
vi.mock('./views/MCPToolView', () => ({ formatMCPTitle: () => 'Demo App' }));
vi.mock('./knownTools', () => ({ knownTools: {} }));
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/utils/toolErrorParser', () => ({ parseToolUseError: () => ({ isToolUseError: false }) }));
vi.mock('./PermissionFooter', () => ({ PermissionFooter: () => null }));
vi.mock('./ToolError', () => ({ ToolError: 'ToolError' }));
vi.mock('../CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('./ToolSectionView', () => ({ ToolSectionView: 'ToolSectionView' }));
vi.mock('./McpAppHost', () => ({ McpAppHost: 'McpAppHost' }));

const baseTool = {
    callId: 'secret-call-id',
    name: 'mcp__demo__show',
    state: 'running' as const,
    input: { city: 'Hangzhou' },
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    description: 'Show demo',
};

describe('ToolView MCP App presentation', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => consoleErrorSpy.mockRestore());

    it('retains the existing title/status header and mounts App content beneath it', () => {
        const tool = {
            ...baseTool,
            mcpApp: { version: 1 as const, server: 'secret-server', resourceUri: 'ui://secret/view.html' },
        };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ToolView metadata={null} tool={tool} sessionId="session-1" />);
        });

        expect(renderer.root.findByProps({ testID: 'tool-card-header' })).toBeTruthy();
        expect(renderer.root.findByProps({ testID: 'mcp-app-content' })).toBeTruthy();
        const host = renderer.root.findByType('McpAppHost');
        expect(host.props).toMatchObject({ sessionId: 'session-1', toolCall: tool, presentation: tool.mcpApp });
        const ownedViews = renderer.root.findAllByType('View').filter((node: any) => node.props.testID);
        expect(ownedViews.map((node: any) => node.props.testID)).toEqual(['tool-card-header', 'mcp-app-content']);
        expect(ownedViews.some((node: any) => (
            'callId' in node.props || 'server' in node.props || 'resourceUri' in node.props
        ))).toBe(false);

        act(() => renderer.unmount());
    });

    it('keeps the old compact MCP fallback when no App presentation exists', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<ToolView metadata={null} tool={baseTool} sessionId="session-1" />);
        });

        expect(renderer.root.findByProps({ testID: 'tool-card-header' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ testID: 'mcp-app-content' })).toHaveLength(0);
        expect(renderer.root.findAllByType('McpAppHost')).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
