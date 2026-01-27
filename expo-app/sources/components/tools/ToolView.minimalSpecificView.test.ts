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
    getToolViewComponent: () => (props: any) => React.createElement('SpecificToolView', { toolName: props.tool?.name }),
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Bash: {
            title: 'Terminal',
            minimal: true,
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

vi.mock('@/agents/catalog', () => ({
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

describe('ToolView (minimal tools)', () => {
    it('renders a specific tool view even when the tool is marked minimal', async () => {
        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'Bash',
            state: 'completed',
            input: { command: 'echo hello' },
            result: { stdout: 'hello\n', stderr: '' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        expect(tree!.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });
});
