import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { markdownSpy, agentContentSpy, sendMessageSpy } = vi.hoisted(() => ({
    markdownSpy: vi.fn(({ markdown }: { markdown: string }) => React.createElement('Text', null, markdown)),
    agentContentSpy: vi.fn(() => React.createElement('View', null, 'agent-content')),
    sendMessageSpy: vi.fn(),
}));

vi.mock('react-native', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Image: (props: any) => React.createElement('Image', props),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => (typeof factory === 'function' ? factory({
            colors: {
                text: '#000',
                textSecondary: '#666',
                surfaceHigh: '#eee',
                userMessageBackground: '#ddd',
            },
        }) : factory),
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: sendMessageSpy,
    },
}));

vi.mock('./markdown/MarkdownView', () => ({
    MarkdownView: markdownSpy,
}));

vi.mock('./AgentContentView', () => ({
    AgentContentView: agentContentSpy,
}));

vi.mock('./layout', () => ({
    layout: {
        maxWidth: 800,
    },
}));

import { MessageView } from './MessageView';

describe('MessageView', () => {
    beforeEach(() => {
        markdownSpy.mockClear();
        agentContentSpy.mockClear();
    });

    it('renders user SessionMessage content in a bubble via MarkdownView', () => {
        let renderer: any;
        act(() => {
            renderer = create(React.createElement(MessageView, {
                sessionId: 'session-1',
                messageId: 'msg:0',
                message: {
                    User: {
                        id: 'user-1',
                        content: [
                            { Text: 'hello' },
                            { Mention: { uri: 'app://note', content: 'Note' } },
                        ],
                    },
                },
            }));
        });
        const tree = renderer.toJSON();

        expect(markdownSpy).toHaveBeenCalledTimes(1);
        const markdownCall = (markdownSpy.mock.calls as unknown as Array<Array<{ markdown: string }>>)[0];
        const markdownProps = markdownCall?.[0];
        expect(markdownProps?.markdown).toBe('hello\n\n[Note](app://note)');
        expect(JSON.stringify(tree)).toContain('hello');
    });

    it('dispatches agent SessionMessage content to AgentContentView', () => {
        act(() => {
            create(React.createElement(MessageView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                metadata: { flavor: 'codex' } as any,
                message: {
                    Agent: {
                        content: [{ Text: 'done' }],
                        tool_results: {},
                    },
                },
            }));
        });

        expect(agentContentSpy).toHaveBeenCalledTimes(1);
        const agentCall = (agentContentSpy.mock.calls as unknown as Array<Array<{ content: unknown; messageId: string }>>)[0];
        const agentProps = agentCall?.[0];
        expect(agentProps?.content).toEqual([{ Text: 'done' }]);
        expect(agentProps?.messageId).toBe('msg:1');
    });

    it('renders Resume messages as a transcript marker', () => {
        let renderer: any;
        act(() => {
            renderer = create(React.createElement(MessageView, {
                sessionId: 'session-1',
                messageId: 'msg:2',
                message: 'Resume',
            }));
        });
        const tree = renderer.toJSON();

        expect(JSON.stringify(tree)).toContain('Resumed session');
    });
});
