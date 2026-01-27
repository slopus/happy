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
                warning: '#f90',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/useElapsedTime', () => ({
    useElapsedTime: () => 123.4,
}));

vi.mock('@/components/tools/views/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {},
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

vi.mock('@/components/CodeView', () => ({
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

describe('ToolView (permission pending)', () => {
    it('does not show elapsed time while waiting for permission', async () => {
        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
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

        const texts = tree!.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts.flatMap((c: any) => Array.isArray(c) ? c : [c]).filter((c: any) => typeof c === 'string');
        expect(flattened).not.toContain('123.4s');
    });

    it('shows elapsed time when running without pending permission', async () => {
        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: undefined,
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        const texts = tree!.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts.flatMap((c: any) => Array.isArray(c) ? c : [c]).filter((c: any) => typeof c === 'string');
        expect(flattened).toContain('123.4s');
    });

    it('does not render PermissionFooter once the tool is completed', async () => {
        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'execute',
            state: 'completed',
            input: { command: 'pwd' },
            result: { stdout: '/tmp\n' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            // Some providers can leave permission status stale; ToolView should not show action buttons in that case.
            permission: { id: 'perm1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any).length).toBe(0);
    });
});
