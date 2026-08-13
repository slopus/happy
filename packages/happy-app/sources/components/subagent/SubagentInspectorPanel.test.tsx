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
    panelBackHandler: null as (() => boolean) | null,
    sessionActive: true,
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
vi.mock('@/components/ToolGroupView', () => ({
    AgentWorkGroupView: (props: Record<string, unknown>) => React.createElement('AgentWorkGroupView', props),
    ToolGroupView: (props: Record<string, unknown>) => React.createElement('ToolGroupView', props),
}));
vi.mock('@/components/AttachmentGalleryView', () => ({
    AttachmentGalleryView: (props: Record<string, unknown>) => React.createElement('AttachmentGalleryView', props),
}));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/components/RightSwipePanelHost', () => ({
    useRightSwipePanel: () => ({
        registerBackHandler: (handler: () => boolean) => {
            mocks.panelBackHandler = handler;
            return () => {
                if (mocks.panelBackHandler === handler) mocks.panelBackHandler = null;
            };
        },
    }),
}));
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ active: mocks.sessionActive, metadata: { flavor: 'codex' } }),
    useSessionMessages: () => ({ messages: mocks.messages, isLoaded: true }),
    useSetting: () => false,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

function toolMessage(
    id: string,
    input: Record<string, unknown>,
    children: Message[] = [],
    name = 'Agent',
): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: Number(id),
        tool: {
            name,
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
        mocks.panelBackHandler = null;
        mocks.sessionActive = true;
    });

    it('renders the selected review task, visible work, and finding without leaking hidden or parent content', () => {
        const visibleProgress: Message = {
            kind: 'agent-text',
            id: 'review-progress',
            localId: null,
            createdAt: 3,
            text: 'Checking the authorization boundary before reviewing callers.',
        };
        const finalFinding: Message = {
            kind: 'agent-text',
            id: 'review-finding',
            localId: null,
            createdAt: 7,
            text: '[P1] Missing authorization guard - sources/api/review.ts:42',
        };
        const parentText: Message = {
            kind: 'agent-text',
            id: 'parent-text',
            localId: null,
            createdAt: 9,
            text: 'Parent implementation summary must stay outside the review inspector.',
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
        const readCall = toolMessage('4', { file_path: 'sources/api/review.ts' }, [], 'Read');
        const grepCall = toolMessage('5', { pattern: 'authorize', path: 'sources/api' }, [], 'Grep');
        const bashCall = toolMessage('6', { command: 'pnpm --filter happy-app test' }, [], 'Bash');
        bashCall.tool.state = 'running';
        bashCall.tool.completedAt = null;
        const skillCall = toolMessage('6.5', { skillNames: ['diagnosing-bugs'] }, [], 'Skill');
        mocks.messages = [
            toolMessage('1', {
                sessionSubagent: 'agent-target',
                title: 'Live title',
                prompt: 'Review the authorization change. Report findings with file and line references.',
            }, [
                ownStatus,
                hiddenReasoning,
                visibleProgress,
                readCall,
                grepCall,
                bashCall,
                skillCall,
                finalFinding,
            ]),
            toolMessage('8', { sessionSubagent: 'agent-parent', title: 'Parent agent' }, [parentText]),
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
        const taskText = renderer.root.findByProps({ testID: 'subagent-inspector-task' });
        expect(taskText.props.children)
            .toBe('Review the authorization change. Report findings with file and line references.');
        expect(taskText.props.style).toEqual(expect.objectContaining({ fontSize: 16, lineHeight: 24 }));
        const renderedMessages = renderer.root.findAllByType('MessageView');
        expect(renderedMessages.map((node: any) => node.props.message.id)).toEqual([
            'review-progress',
            '4',
            '5',
            '6',
            'review-finding',
        ]);
        expect(renderedMessages.find((node: any) => node.props.message.id === '6')?.props.message.tool)
            .toMatchObject({ state: 'completed', completedAt: 6 });
        expect(bashCall.tool).toMatchObject({ state: 'running', completedAt: null });
        const skillGroup = renderer.root.findByType('ToolGroupView');
        expect(skillGroup.props).toMatchObject({
            expanded: false,
            group: {
                id: 'group-6.5',
                messages: [{ id: '6.5' }],
            },
        });
        expect(JSON.stringify(renderer.toJSON())).not.toContain('Private chain of thought');
        expect(JSON.stringify(renderer.toJSON())).not.toContain('Parent implementation summary');

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

    it('settles stale child tools when the parent session stops without a subagent terminal event', () => {
        const bashCall = toolMessage('2', { command: 'pnpm test' }, [], 'Bash');
        bashCall.tool.state = 'running';
        bashCall.tool.completedAt = null;
        const staleRunningStatus: Message = {
            kind: 'agent-event',
            id: 'stale-running-status',
            createdAt: 3,
            event: {
                type: 'subagent-status',
                subagent: 'agent-target',
                status: 'running',
            },
        };
        mocks.sessionActive = false;
        mocks.messages = [
            toolMessage('1', {
                sessionSubagent: 'agent-target',
                prompt: 'Run the tests.',
            }, [bashCall, staleRunningStatus]),
        ];

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SubagentInspectorPanel onBack={vi.fn()} selection={selection} sessionId="session-one" />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'subagent-inspector-status' }).props.children)
            .toBe('toolGroup.subagentStatus.running');
        expect(renderer.root.findByType('MessageView').props.message.tool)
            .toMatchObject({ state: 'completed', completedAt: 2 });
        expect(bashCall.tool).toMatchObject({ state: 'running', completedAt: null });
        act(() => renderer.unmount());
    });

    it('routes compact system back through the same inspector back action', () => {
        mocks.messages = [toolMessage('1', {
            sessionSubagent: 'agent-target',
            prompt: 'Review the change.',
        })];
        const onBack = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SubagentInspectorPanel onBack={onBack} selection={selection} sessionId="session-one" />,
            );
        });

        expect(mocks.panelBackHandler).toEqual(expect.any(Function));
        expect(mocks.panelBackHandler?.()).toBe(true);
        expect(onBack).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
        expect(mocks.panelBackHandler).toBeNull();
    });
});
