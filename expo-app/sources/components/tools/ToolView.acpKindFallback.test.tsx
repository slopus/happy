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
    getToolViewComponent: (toolName: string) =>
        toolName === 'execute'
            ? (props: any) => React.createElement('SpecificToolView', { resolvedName: props.tool?.name })
            : null,
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        execute: {
            title: 'Terminal',
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

describe('ToolView (ACP kind fallback)', () => {
    it('uses tool.input._acp.kind to pick a specific view when tool.name is not a stable key', async () => {
        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'Run echo hello',
            state: 'completed',
            input: { _acp: { kind: 'execute', title: 'Run echo hello' }, command: ['/bin/zsh', '-lc', 'echo hello'] },
            result: { stdout: 'hello\n', stderr: '' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: 'Run echo hello',
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
