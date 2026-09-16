import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations in this workspace.
// @ts-expect-error The test only uses create and unmount.
import TestRenderer from 'react-test-renderer';

import { MessageView } from './MessageView';

const autoFold = vi.hoisted(() => ({
    getBody: vi.fn<(args: unknown) => any>(() => ({ kind: 'preview-text', text: 'preview' })),
    getInfo: vi.fn<(text: string) => any>(() => null),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    Pressable: 'Pressable',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./tools/ToolView', () => ({ ToolView: 'ToolView' }));
vi.mock('./ConversationActivityStrip', () => ({ ConversationActivityStrip: 'ConversationActivityStrip' }));
vi.mock('./DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'DesktopShortcutTooltip' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 900 } }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/autoFoldPrompt', () => ({
    getAutoFoldPromptBodyRenderState: autoFold.getBody,
    getAutoFoldPromptInfo: autoFold.getInfo,
}));
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'common.copy': 'Copy',
        'common.copied': 'Copied',
        'common.loading': 'Loading',
        'session.forkFromHere': 'Fork from here',
    })[key] ?? key,
}));
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

const agentMessage = {
    kind: 'agent-text' as const,
    id: 'agent-1',
    localId: null,
    createdAt: 2,
    text: 'A response that can be forked.',
};

const forkTarget = {
    messageId: 'user-1',
    messageText: 'Original prompt',
    messageCreatedAt: 1,
    rewindPointId: 'item-1',
};

function flattenStyle(style: unknown): Record<string, unknown> {
    return Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean));
}

describe('MessageView fork action feedback', () => {
    it('passes the next question as an excluded boundary when its fork button is clicked', () => {
        const onFork = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageView message={agentMessage} metadata={null}
                showAgentMessageActions agentForkTarget={{ ...forkTarget, rewindPointId: 'next-item',
                    messageText: 'Next question', excludeSelectedPrompt: true }} onForkFromMessage={onFork} />);
        });
        act(() => renderer.root.findByProps({ testID: 'message-agent-fork-agent-1' }).props.onPress());
        expect(onFork).toHaveBeenCalledWith('user-1', 'next-item', 'Next question', false, 1, true);
        act(() => renderer.unmount());
    });
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        autoFold.getBody.mockReset().mockReturnValue({ kind: 'preview-text', text: 'preview' });
        autoFold.getInfo.mockReset().mockReturnValue(null);
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('selects chat typography for user, agent, and expanded folded Markdown', () => {
        let renderer: any;
        const userMessage = {
            kind: 'user-text' as const,
            id: 'user-1',
            localId: null,
            createdAt: 1,
            text: 'Use `pnpm test`.',
        };

        act(() => {
            renderer = TestRenderer.create(<MessageView message={userMessage} metadata={null} />);
        });
        expect(renderer.root.findByType('MarkdownView').props.typography).toBe('chatMono');

        act(() => renderer.update(<MessageView message={agentMessage} metadata={null} />));
        expect(renderer.root.findByType('MarkdownView').props.typography).toBe('chatMono');

        autoFold.getInfo.mockReturnValue({ charCount: 2000, lineCount: 20, preview: 'preview' });
        autoFold.getBody.mockReturnValue({ kind: 'markdown', text: agentMessage.text, markdownVariant: 'foldedPrompt' });
        act(() => renderer.update(<MessageView message={{ ...agentMessage, text: `${agentMessage.text} folded` }} metadata={null} />));
        expect(renderer.root.findByType('MarkdownView').props).toMatchObject({
            typography: 'chatMono',
            variant: 'foldedPrompt',
        });

        act(() => renderer.unmount());
    });

    it('uses the inline Skills activity for standalone Ego calls without hiding pending permission', () => {
        const message: any = { kind: 'tool-call', id: 'ego', localId: null, createdAt: 1, children: [],
            tool: { name: 'Skill', input: { skill: 'ego-browser' }, state: 'completed', createdAt: 1, startedAt: 1, completedAt: 1, description: null } };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<MessageView message={message} metadata={null} sessionId="s1" />); });
        expect(renderer.root.findByType('ConversationActivityStrip').props.messages).toEqual([message]);
        expect(renderer.root.findAllByType('ToolView')).toHaveLength(0);
        act(() => renderer.update(<MessageView message={{ ...message, tool: { ...message.tool, permission: { status: 'pending' } } }} metadata={null} sessionId="s1" />));
        expect(renderer.root.findAllByType('ToolView')).toHaveLength(1);
        act(() => renderer.unmount());
    });

    it('keeps the action strip inside the message hover boundary', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <MessageView
                    message={agentMessage}
                    metadata={null}
                    showAgentMessageActions
                    agentForkTarget={forkTarget}
                    onForkFromMessage={() => {}}
                />,
            );
        });

        const message = renderer.root.findByProps({ testID: 'message-agent-agent-1' });
        const actions = renderer.root.findByProps({ testID: 'message-agent-actions-agent-1' });
        const messageStyle = flattenStyle(message.props.style);
        const actionsStyle = flattenStyle(actions.props.style);

        expect(messageStyle.paddingBottom).toBeGreaterThanOrEqual(28);
        expect(actionsStyle.bottom).toBe(0);

        act(() => renderer.unmount());
    });

    it('replaces the fork icon with a disabled busy indicator while the request is pending', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <MessageView
                    message={agentMessage}
                    metadata={null}
                    showAgentMessageActions
                    agentForkTarget={forkTarget}
                    onForkFromMessage={() => {}}
                    forkingFromMessageId="user-1"
                />,
            );
        });

        const forkButton = renderer.root.findByProps({ testID: 'message-agent-fork-agent-1' });
        expect(forkButton.props.disabled).toBe(true);
        expect(forkButton.props.accessibilityLabel).toBe('Loading');
        expect(forkButton.props.accessibilityState).toEqual({ busy: true, disabled: true });
        expect(forkButton.findAllByType('ActivityIndicator')).toHaveLength(1);
        expect(forkButton.findAllByType('Ionicons')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('does not show the pending indicator on another message action', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <MessageView
                    message={agentMessage}
                    metadata={null}
                    showAgentMessageActions
                    agentForkTarget={forkTarget}
                    onForkFromMessage={() => {}}
                    forkingFromMessageId="another-user-message"
                />,
            );
        });

        const forkButton = renderer.root.findByProps({ testID: 'message-agent-fork-agent-1' });
        expect(forkButton.props.disabled).toBe(false);
        expect(forkButton.props.accessibilityLabel).toBe('Fork from here');
        expect(forkButton.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(forkButton.findAllByType('Ionicons')).toHaveLength(1);

        act(() => renderer.unmount());
    });

    it('routes a typed interactive preview event through the normal tool message path', () => {
        const tool = {
            name: 'interactive-preview', state: 'completed', createdAt: 1, startedAt: 1, completedAt: 1,
            input: { version: 1, id: '11111111-1111-4111-8111-111111111111', title: 'Toolbar', state: 'ready', url: 'https://draft.example' },
            description: null,
        } as any;
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageView
                message={{ kind: 'tool-call', id: 'preview-message', localId: null, createdAt: 1, tool, children: [] }}
                metadata={null}
            />);
        });

        expect(renderer.root.findByType('ToolView').props).toMatchObject({
            tool: expect.objectContaining({ name: 'interactive-preview', input: expect.objectContaining({ state: 'ready' }) }),
            messageId: 'preview-message',
        });
        act(() => renderer.unmount());
    });
});
