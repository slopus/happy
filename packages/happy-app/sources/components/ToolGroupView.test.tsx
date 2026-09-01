import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('@/hooks/useGroupedMessages', () => ({
    formatWorkDuration: () => '1s',
    generateGroupSummary: () => 'Read file',
    groupToolCallsForDisplay: () => [],
}));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 1 }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./tools/views/MCPToolView', () => ({ formatMCPTitle: (name: string) => name }));
vi.mock('./ConversationActivityStrip', () => ({
    ConversationActivityStrip: 'ConversationActivityStrip',
    ConversationActivitySuppressedContext: React.createContext(false),
}));

const { theme } = vi.hoisted(() => ({ theme: {
    colors: {
        divider: '#333',
        surfacePressed: '#292929',
        text: '#fff',
        textSecondary: '#aaa',
    },
} }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: { create: (factory: any) => factory(theme) },
}));

import { AgentWorkGroupView } from './ToolGroupView';

describe('AgentWorkGroupView', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('shows the summary category icon beside the disclosure chevron', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AgentWorkGroupView
                    group={{
                        type: 'agent-work-group',
                        id: 'work-1',
                        messages: [{
                            id: 'read-1',
                            kind: 'tool-call',
                            createdAt: 1,
                            tool: { name: 'Read', input: { file_path: '/tmp/a.ts' }, state: 'completed' },
                        }] as any,
                        hasRunning: false,
                        hasPendingPermission: false,
                        startedAt: 1_000,
                        completedAt: 2_000,
                    }}
                    metadata={null}
                    expanded={false}
                    onToggle={() => undefined}
                />,
            );
        });

        const toggle = renderer.root.findByProps({ testID: 'conversation-agent-work-toggle' });
        expect(toggle.findByProps({ testID: 'conversation-tool-summary-icon' }).findByType('Octicons').props.name).toBe('eye');
        expect(toggle.findByProps({ testID: 'conversation-collapse-chevron' }).props.name).toBe('chevron-forward');

        act(() => renderer.unmount());
    });
});
