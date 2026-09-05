import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations in this workspace.
// @ts-expect-error The test only uses create and unmount.
import TestRenderer from 'react-test-renderer';

import { MessageView } from './MessageView';

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
    getAutoFoldPromptBodyRenderState: () => ({ collapsed: false }),
    getAutoFoldPromptInfo: () => null,
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
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => consoleErrorSpy.mockRestore());

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
});
