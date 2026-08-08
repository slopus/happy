import * as React from 'react';
import { act } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import type { SubagentInspectorSelection } from './SubagentInspectorContext';
import { SubagentInspectorPanel } from './SubagentInspectorPanel';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    messages: [] as Message[],
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: object) => object)({
                colors: {
                    divider: '#444444',
                    success: '#00ff00',
                    surface: '#111111',
                    text: '#ffffff',
                    textDestructive: '#ff0000',
                    textSecondary: '#aaaaaa',
                    warning: '#ffaa00',
                },
            })
            : factory,
    },
    useUnistyles: () => ({
        theme: { colors: { success: '#00ff00', textDestructive: '#ff0000', textSecondary: '#aaaaaa', warning: '#ffaa00' } },
    }),
}));
vi.mock('@/components/MessageView', () => ({
    MessageView: (props: Record<string, unknown>) => React.createElement('MessageView', props),
}));
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ metadata: { flavor: 'codex' } }),
    useSessionMessages: () => ({ messages: mocks.messages, isLoaded: true }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

function toolMessage(
    id: string,
    input: Record<string, unknown>,
    children: Message[] = [],
): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: Number(id),
        tool: {
            name: 'Agent',
            input,
            state: 'completed',
            createdAt: Number(id),
            startedAt: Number(id),
            completedAt: Number(id),
            description: null,
        },
        children,
    };
}

const selection: SubagentInspectorSelection = {
    id: 'agent-target',
    title: 'Initial title',
    status: 'running',
};

describe('SubagentInspectorPanel', () => {
    beforeAll(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        mocks.messages = [];
    });

    it('renders only the selected agent transcript and forwards back', () => {
        const targetText: Message = {
            kind: 'agent-text',
            id: 'target-text',
            localId: null,
            createdAt: 3,
            text: 'Target output',
        };
        const siblingText: Message = {
            kind: 'agent-text',
            id: 'sibling-text',
            localId: null,
            createdAt: 5,
            text: 'Sibling output',
        };
        const ownStatus: Message = {
            kind: 'agent-event',
            id: 'target-own-status',
            createdAt: 2,
            event: {
                type: 'subagent-status',
                subagent: 'agent-target',
                title: 'Live title',
                status: 'running',
            },
        };
        const hiddenReasoning: Message = {
            kind: 'agent-text',
            id: 'target-hidden-reasoning',
            localId: null,
            createdAt: 2.5,
            text: 'Private chain of thought',
            isThinking: true,
        };
        mocks.messages = [
            toolMessage('1', { sessionSubagent: 'agent-target', title: 'Live title' }, [
                ownStatus,
                hiddenReasoning,
                targetText,
            ]),
            toolMessage('4', { sessionSubagent: 'agent-sibling', title: 'Live title' }, [siblingText]),
            {
                kind: 'agent-event',
                id: 'target-status',
                createdAt: 6,
                event: {
                    type: 'subagent-status',
                    subagent: 'agent-target',
                    title: 'Live title',
                    status: 'completed',
                },
            },
        ];
        const onBack = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SubagentInspectorPanel onBack={onBack} selection={selection} sessionId="session-one" />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'subagent-inspector-title' }).props.children).toBe('Live title');
        expect(renderer.root.findByProps({ testID: 'subagent-inspector-status' }).props.children)
            .toBe('toolGroup.subagentStatus.completed');
        const renderedMessages = renderer.root.findAllByType('MessageView');
        expect(renderedMessages).toHaveLength(1);
        expect(renderedMessages[0].props.message).toBe(targetText);
        expect(JSON.stringify(renderer.toJSON())).not.toContain('Private chain of thought');

        act(() => renderer.root.findByProps({ testID: 'subagent-inspector-back' }).props.onPress());
        expect(onBack).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('shows an honest empty state when the selected record was not captured', () => {
        mocks.messages = [toolMessage('1', { sessionSubagent: 'agent-sibling' }, [])];
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SubagentInspectorPanel onBack={vi.fn()} selection={selection} sessionId="session-one" />,
            );
        });

        expect(renderer.root.findAllByType('MessageView')).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'subagent-inspector-empty' }).props.children)
            .toBe('toolGroup.subagentNoDetails');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('Sibling output');
        act(() => renderer.unmount());
    });
});
