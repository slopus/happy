import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios', select: (v: any) => v.ios },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                surfaceHigh: '#fff',
                surfaceHighest: '#fff',
                text: '#000',
                textSecondary: '#666',
                warning: '#f00',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/tools/views/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        ExitPlanMode: {
            title: 'Plan proposal',
        },
        exit_plan_mode: {
            title: 'Plan proposal',
        },
    },
}));

vi.mock('@/components/tools/views/MCPToolView', () => ({
    formatMCPTitle: () => 'MCP',
}));

vi.mock('@/utils/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('../CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('./ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('./ToolError', () => ({
    ToolError: () => null,
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/agents/registryCore', () => ({
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

describe('ToolView (ExitPlanMode)', () => {
    it('does not render PermissionFooter for ExitPlanMode', async () => {
        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'ExitPlanMode',
            state: 'running',
            input: { plan: 'plan' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: { id: 'perm1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any)).toHaveLength(0);
    });

    it('renders PermissionFooter for normal tools', async () => {
        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'Write',
            state: 'running',
            input: { file_path: '/tmp/x', content: 'x' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: { id: 'perm1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any).length).toBeGreaterThan(0);
    });
});
