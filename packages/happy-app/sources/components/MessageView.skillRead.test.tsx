import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { MessageView } from './MessageView';
import { ConversationActivitySuppressedContext } from './ConversationActivityStrip';

// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('./DesktopDialogFrame', () => ({ DesktopDialogFrame: 'DesktopDialogFrame' }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./tools/ToolView', () => ({ ToolView: 'ToolView' }));
vi.mock('./SkillBrowserProgress', () => ({ SkillBrowserProgress: () => null }));
vi.mock('./subagent/SubagentInspectorContext', () => ({ useSubagentInspector: () => null }));
vi.mock('./DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'DesktopShortcutTooltip' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 900 } }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const nestedTheme = new Proxy({}, {
        get: (_target, property) => property === 'toString' ? () => '#000000' : nestedTheme,
    });
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: (theme: object) => object) => factory({ colors: nestedTheme }),
        },
        useUnistyles: () => ({ theme: { colors: nestedTheme } }),
    };
});

function toolMessage(name = 'Read', filePath = '/skills/photo-to-styled-motion/SKILL.md'): ToolCallMessage {
    return {
        kind: 'tool-call', id: 'read-one', localId: null, createdAt: 1, children: [],
        tool: {
            name,
            input: name === 'Skill' ? { skill: 'photo-to-styled-motion' } : { file_path: filePath },
            state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2, description: null,
        },
    };
}

describe('MessageView Skill document routing', () => {
    let renderer: any;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
    });

    const renderMessage = (message: ToolCallMessage, suppressActivities = false) => {
        act(() => {
            renderer = TestRenderer.create(
                <ConversationActivitySuppressedContext.Provider value={suppressActivities}>
                    <MessageView message={message} metadata={null} sessionId="session-one" />
                </ConversationActivitySuppressedContext.Provider>,
            );
        });
    };
    const texts = () => renderer.root.findAllByType('Text').map((node: any) => node.children.join(''));

    it('adds a document-load activity while retaining the original Read details and navigation identity', () => {
        const message = toolMessage();
        renderMessage(message);

        const originalRead = renderer.root.findByType('ToolView');
        expect(originalRead.props.tool).toBe(message.tool);
        expect(originalRead.props).toMatchObject({ sessionId: 'session-one', messageId: 'read-one' });
        expect(originalRead.props.messages).toBe(message.children);
        expect(texts()).toContain('toolGroup.skillDocumentLabel');
        expect(texts()).toContain('photo-to-styled-motion');
        expect(texts()).toContain('toolGroup.skillDocumentStatus.completed');
    });

    it('continues to render a native Skill invocation as an activity without a duplicate ToolView', () => {
        renderMessage(toolMessage('Skill'));

        expect(renderer.root.findAllByType('ToolView')).toHaveLength(0);
        expect(texts()).toContain('toolGroup.skillLabel');
        expect(texts()).not.toContain('toolGroup.skillDocumentLabel');
    });

    it('retains the original Read when its duplicate activity is suppressed by a surrounding tool group', () => {
        const message = toolMessage();
        renderMessage(message, true);

        expect(renderer.root.findByType('ToolView').props.tool).toBe(message.tool);
        expect(texts()).not.toContain('toolGroup.skillDocumentLabel');
    });

    it('retains an agy command and its permission details when the group already renders its Skill activity', () => {
        const message = toolMessage('execute');
        message.tool.input = { CommandLine: "cat '/skills/ego-ops/SKILL.md'" };
        renderMessage(message, true);
        expect(renderer.root.findByType('ToolView').props.tool).toBe(message.tool);
    });

    it('leaves an ordinary file Read as only the original ToolView', () => {
        const message = toolMessage('Read', '/repo/minimax.py');
        renderMessage(message);

        expect(renderer.root.findByType('ToolView').props.tool).toBe(message.tool);
        expect(texts()).not.toContain('toolGroup.skillDocumentLabel');
        expect(texts()).not.toContain('toolGroup.skillLabel');
    });

    it('passes a pending document Read and its permission unchanged to the original ToolView', () => {
        const message = toolMessage();
        message.tool.state = 'running';
        message.tool.completedAt = null;
        message.tool.permission = { id: 'read-permission', status: 'pending' };
        renderMessage(message);

        const originalRead = renderer.root.findByType('ToolView');
        expect(originalRead.props.tool).toBe(message.tool);
        expect(originalRead.props.tool.permission).toBe(message.tool.permission);
        expect(originalRead.props).toMatchObject({ sessionId: 'session-one', messageId: 'read-one' });
        expect(texts()).not.toContain('toolGroup.skillDocumentLabel');
    });
});
