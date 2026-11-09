import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { TranscriptGroupExpansionContext } from './transcriptReading';
const grouping = vi.hoisted(() => ({ nested: [] as any[], messageRenders: [] as string[] }));

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
    groupToolCallsForDisplay: () => grouping.nested,
}));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 1 }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./MessageView', () => ({ MessageView: (props: any) => {
    grouping.messageRenders.push(props.message.id);
    return React.createElement('MessageView', props);
} }));
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
        grouping.nested = [];
        grouping.messageRenders = [];
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

    it('never mounts closed nested tool output during history discovery', () => {
        const messages = ['one', 'two'].map(id => ({ id, kind: 'agent-text', text: id, createdAt: 1, localId: null }));
        const render = () => <AgentWorkGroupView group={{ type: 'agent-work-group', id: 'work',
            messages: [...messages] as any, hasRunning: false, hasPendingPermission: false,
            startedAt: 1, completedAt: 2 }} metadata={null} expanded onToggle={() => {}} />;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(render()); });
        grouping.nested = [{ type: 'tool-group', id: 'historical-tools', messages,
            hasRunning: false, hasPendingPermission: false }];
        act(() => renderer.update(render()));
        expect(grouping.messageRenders).toEqual([]);
        act(() => renderer.root.findByProps({ testID: 'conversation-tool-group-toggle' }).props.onPress());
        expect(renderer.root.findAllByType('MessageView')).toHaveLength(2);
        act(() => renderer.unmount());
    });

    it('restores nested tool-group expansion from the durable reading context', () => {
        const messages = ['one', 'two'].map(id => ({ id, kind: 'agent-text', text: id, createdAt: 1, localId: null }));
        grouping.nested = [{ type: 'tool-group', id: 'replayed-group', messages, hasRunning: false, hasPendingPermission: false }];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<TranscriptGroupExpansionContext.Provider value={{ isExpanded: () => true, toggle: vi.fn() }}>
            <AgentWorkGroupView group={{ type: 'agent-work-group', id: 'work', messages: messages as any, hasRunning: false,
                hasPendingPermission: false, startedAt: 1, completedAt: 2 }} metadata={null} expanded onToggle={() => {}} />
        </TranscriptGroupExpansionContext.Provider>); });
        expect(renderer.root.findAllByType('MessageView')).toHaveLength(2);
        act(() => renderer.unmount());
    });
});

vi.mock('@/hooks/useDesktopFileWorkspaceAvailable', () => ({ useDesktopFileWorkspaceAvailable: () => false }));
