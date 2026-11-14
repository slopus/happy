import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations in this workspace.
// @ts-expect-error The test only uses create and unmount.
import TestRenderer from 'react-test-renderer';

import { MessageView } from './MessageView';
import { TranscriptReadOnlyContext, TranscriptRestrictedContentContext, TranscriptMessageOptionsContext } from './TranscriptReadOnlyContext';
import * as Clipboard from 'expo-clipboard';

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
const syncMocks = vi.hoisted(() => ({
    sendMessage: vi.fn(), recordMessageOptionResponse: vi.fn(),
    getMessageWireId: vi.fn(), getMessageWireBlockKey: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({ sync: syncMocks }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
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
    it('places the user avatar after the message while keeping the Paws avatar before its reply', () => {
        const avatar = { id: 'jacky', imageUrl: null };
        const userMessage = { kind: 'user-text' as const, id: 'user-avatar', localId: null, createdAt: 1, text: 'Hello' };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<MessageView message={userMessage} metadata={null} turnAvatar={avatar} />); });
        const userStyle = flattenStyle(renderer.root.findByProps({ testID: 'dreamskin-turn-avatar-user-avatar' }).props.style);
        expect(userStyle.right).toBe(-36);
        expect(userStyle.left).toBeUndefined();

        act(() => renderer.update(<MessageView message={agentMessage} metadata={null} turnAvatar={avatar} />));
        const agentStyle = flattenStyle(renderer.root.findByProps({ testID: 'dreamskin-turn-avatar-agent-1' }).props.style);
        expect(agentStyle.left).toBe(-36);
        expect(agentStyle.right).toBeUndefined();
        act(() => renderer.unmount());
    });

    it('keeps history source identity but disables options and user/agent mutation actions', () => {
        const onFork = vi.fn();
        const onEdit = vi.fn();
        for (const message of [agentMessage, { ...agentMessage, kind: 'user-text' as const }]) {
            let renderer: any;
            act(() => {
                renderer = TestRenderer.create(<TranscriptReadOnlyContext.Provider value={true}>
                    <MessageView message={message} metadata={null} sessionId="original-session"
                        showAgentMessageActions showUserMessageActions canEditUserMessage
                        agentForkTarget={forkTarget} onForkFromMessage={onFork} onEditUserMessage={onEdit} />
                </TranscriptReadOnlyContext.Provider>);
            });
            expect(renderer.root.findByType('MarkdownView').props.sessionId).toBe('original-session');
            expect(renderer.root.findByType('MarkdownView').props.onOptionPress).toBeUndefined();
            const copyId = message.kind === 'user-text' ? `message-user-copy-${message.id}` : `message-agent-copy-${message.id}`;
            act(() => renderer.root.findByProps({ testID: copyId }).props.onPress());
            expect(Clipboard.setStringAsync).toHaveBeenCalledWith(message.text);
            expect(renderer.root.findAllByProps({ testID: `message-user-edit-${message.id}` })).toHaveLength(0);
            expect(renderer.root.findAllByType('Pressable').filter((node: any) =>
                node.props.onLongPress || node.props.testID?.startsWith('message-agent-fork'))).toHaveLength(0);
            expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);
            expect(onFork).not.toHaveBeenCalled();
            expect(onEdit).not.toHaveBeenCalled();
            act(() => renderer.unmount());
        }
    });

    it('preserves inert external Markdown without restricting ordinary history formatting', () => {
        for (const restricted of [false, true]) {
            let renderer: any;
            act(() => {
                renderer = TestRenderer.create(<TranscriptReadOnlyContext.Provider value={true}>
                    <TranscriptRestrictedContentContext.Provider value={restricted}>
                        <MessageView message={agentMessage} metadata={null} />
                    </TranscriptRestrictedContentContext.Provider>
                </TranscriptReadOnlyContext.Provider>);
            });
            expect(renderer.root.findByType('MarkdownView').props.readOnly).toBe(restricted);
            act(() => renderer.unmount());
        }
    });

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
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('selects chat typography for user and agent Markdown', () => {
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

        act(() => renderer.unmount());
    });

    it.each(['user-text', 'agent-text'] as const)('renders long %s prompts in full with options and copy actions', (kind) => {
        const text = [
            '风格提示词 / Style prompt:',
            ...Array.from({ length: 32 }, (_, index) => `第 ${index} 条：保持纸张纹理、克制构图与自然阴影。Preserve the complete instructions and all details.`),
            '<options><option>Continue</option></options>',
            'Final instruction must remain visible.',
        ].join('\n');
        const message = { ...agentMessage, kind, text };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageView message={message} metadata={null} sessionId="s1"
                showUserMessageActions showAgentMessageActions />);
        });
        expect(renderer.root.findByType('MarkdownView').props).toMatchObject({ markdown: text, typography: 'chatMono', sessionId: 's1' });
        expect(renderer.root.findByType('MarkdownView').props.variant).toBeUndefined();
        expect(renderer.root.findByType('MarkdownView').props.onOptionPress).toBeTypeOf('function');
        const copyId = kind === 'user-text' ? 'message-user-copy-agent-1' : 'message-agent-copy-agent-1';
        act(() => renderer.root.findByProps({ testID: copyId }).props.onPress());
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith(text);

        act(() => renderer.update(<TranscriptReadOnlyContext.Provider value={true}>
            <MessageView message={message} metadata={null} sessionId="s1" />
        </TranscriptReadOnlyContext.Provider>));
        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe(text);
        expect(renderer.root.findByType('MarkdownView').props.onOptionPress).toBeUndefined();
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


describe('native async question rendering', () => {
    it('shows one structured card instead of repeating the question as Markdown', () => {
        const message = { ...agentMessage, asyncQuestion: { id: 'question-item', questions: [{ title: 'Screenshots?', options: ['Yes', 'No'] }] } };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<MessageView message={message} metadata={{ path: '/project', host: 'machine', capabilities: { codexAsyncQuestions: true } }} sessionId="session" />); });
        expect(renderer.root.findAllByType('MarkdownView')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'async-question-card' }).filter((node: any) => typeof node.type === 'string')).toHaveLength(1);
        act(() => renderer.unmount());
    });
});


describe('MessageView persistent option receipts', () => {
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        syncMocks.sendMessage.mockReset().mockResolvedValue(undefined);
        syncMocks.recordMessageOptionResponse.mockReset().mockResolvedValue(undefined);
        syncMocks.getMessageWireId.mockReset().mockReturnValue('wire-question');
        syncMocks.getMessageWireBlockKey.mockReset().mockReturnValue('text:2');
    });

    function mount(props: Record<string, unknown> = {}, context?: React.ContextType<typeof TranscriptMessageOptionsContext>) {
        let renderer: any;
        act(() => {
            const message = <MessageView message={agentMessage} metadata={null} sessionId="session" {...props} />;
            renderer = TestRenderer.create(context ? <TranscriptMessageOptionsContext.Provider value={context}>
                <React.Fragment>{message}</React.Fragment>
            </TranscriptMessageOptionsContext.Provider> : message);
        });
        return renderer;
    }

    it('uses sync wire/block identity and forwards metadata receipts to Markdown', () => {
        const responses = { 'saved-key': { status: 'answered' as const, answer: 'A', updatedAt: 3 } };
        const renderer = mount({ metadata: { path: '/project', host: 'machine', messageOptionResponses: responses } });
        const markdown = renderer.root.findByType('MarkdownView');
        expect(syncMocks.getMessageWireId).toHaveBeenCalledWith('session', 'agent-1');
        expect(syncMocks.getMessageWireBlockKey).toHaveBeenCalledWith('session', 'agent-1');
        expect(markdown.props.optionKey).toBe(JSON.stringify(['wire-question', 'text:2']));
        expect(markdown.props.optionResponses).toBe(responses);
        act(() => renderer.unmount());
    });

    it('resolves after an accepted send even when saving its receipt fails', async () => {
        syncMocks.recordMessageOptionResponse.mockRejectedValueOnce(new Error('receipt unavailable'));
        const renderer = mount();
        const choose = renderer.root.findByType('MarkdownView').props.onOptionPress;
        await expect(choose({ title: 'A', responseKey: 'stable-key:0' })).resolves.toBeUndefined();
        expect(syncMocks.sendMessage).toHaveBeenCalledExactlyOnceWith('session', 'A', { source: 'option' });
        expect(syncMocks.recordMessageOptionResponse).toHaveBeenCalledExactlyOnceWith('session', 'stable-key:0', {
            status: 'answered', answer: 'A', updatedAt: expect.any(Number),
        });
        expect(syncMocks.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(syncMocks.recordMessageOptionResponse.mock.invocationCallOrder[0]);
        act(() => renderer.unmount());
    });

    it('rejects a failed send without recording a completed answer', async () => {
        syncMocks.sendMessage.mockRejectedValueOnce(new Error('outbox unavailable'));
        const renderer = mount();
        await expect(renderer.root.findByType('MarkdownView').props.onOptionPress({ title: 'A', responseKey: 'key:0' }))
            .rejects.toThrow('outbox unavailable');
        expect(syncMocks.recordMessageOptionResponse).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('rejects a failed dismiss receipt so the card can remain available', async () => {
        syncMocks.recordMessageOptionResponse.mockRejectedValueOnce(new Error('receipt unavailable'));
        const renderer = mount();
        await expect(renderer.root.findByType('MarkdownView').props.onOptionDismiss('stable-key:0'))
            .rejects.toThrow('receipt unavailable');
        expect(syncMocks.recordMessageOptionResponse).toHaveBeenCalledExactlyOnceWith('session', 'stable-key:0', {
            status: 'dismissed', updatedAt: expect.any(Number),
        });
        expect(syncMocks.sendMessage).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('records a successful dismissal without sending a new chat message', async () => {
        const renderer = mount();
        await expect(renderer.root.findByType('MarkdownView').props.onOptionDismiss('stable-key:0')).resolves.toBeUndefined();
        expect(syncMocks.recordMessageOptionResponse).toHaveBeenCalledExactlyOnceWith('session', 'stable-key:0', {
            status: 'dismissed', updatedAt: expect.any(Number),
        });
        expect(syncMocks.sendMessage).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it.each(['answered', 'dismissed'] as const)('passes a %s context receipt into nested message rows and blocks another send', async status => {
        const response = { status, updatedAt: 3, ...(status === 'answered' ? { answer: 'A' } : {}) };
        const renderer = mount({}, { responses: new Map([['agent-1', response]]), inactive: false });
        const markdown = renderer.root.findByType('MarkdownView');
        expect(markdown.props.optionResponse).toBe(response);
        await markdown.props.onOptionPress({ title: 'A', responseKey: 'stable-key:0' });
        expect(syncMocks.sendMessage).not.toHaveBeenCalled();
        expect(syncMocks.recordMessageOptionResponse).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });

    it('passes inactive context into nested rows and blocks both mutation paths', async () => {
        const renderer = mount({}, { responses: new Map(), inactive: true });
        const markdown = renderer.root.findByType('MarkdownView');
        expect(markdown.props.optionsInactive).toBe(true);
        await markdown.props.onOptionPress({ title: 'A', responseKey: 'stable-key:0' });
        await expect(markdown.props.onOptionDismiss('stable-key:0')).rejects.toThrow('Read-only transcript');
        expect(syncMocks.sendMessage).not.toHaveBeenCalled();
        expect(syncMocks.recordMessageOptionResponse).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });
});
