import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { markdownSpy, toolUseViewSpy, sendMessageSpy } = vi.hoisted(() => ({
    markdownSpy: vi.fn(({ markdown }: { markdown: string }) => React.createElement('Text', null, markdown)),
    toolUseViewSpy: vi.fn(() => React.createElement('View', null, 'tool-use')),
    sendMessageSpy: vi.fn(),
}));

vi.mock('react-native', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => (typeof factory === 'function' ? factory({
            colors: {
                text: '#000',
                textSecondary: '#666',
                surfaceHigh: '#eee',
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

vi.mock('./ToolUseView', () => ({
    ToolUseView: toolUseViewSpy,
}));

import { AgentContentView } from './AgentContentView';

describe('AgentContentView', () => {
    beforeEach(() => {
        markdownSpy.mockClear();
        toolUseViewSpy.mockClear();
    });

    it('renders text, thinking, redacted thinking, and tool use blocks', () => {
        const toolUse = {
            id: 'tool-1',
            name: 'Read',
            raw_input: '{"path":"/tmp/file"}',
            input: { path: '/tmp/file' },
            is_input_complete: true,
        };
        const toolResult = {
            tool_use_id: 'tool-1',
            tool_name: 'Read',
            is_error: false,
            content: { Text: 'file contents' },
        };

        let renderer: any;
        act(() => {
            renderer = create(React.createElement(AgentContentView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                content: [
                    { Text: 'assistant text' },
                    { Thinking: { text: 'private reasoning' } },
                    { RedactedThinking: 'hidden' },
                    { ToolUse: toolUse },
                ],
                toolResults: { 'tool-1': toolResult },
            }));
        });
        const tree = renderer.toJSON();

        expect(markdownSpy).toHaveBeenCalledTimes(2);
        const markdownCalls = markdownSpy.mock.calls as unknown as Array<Array<{ markdown: string }>>;
        const firstMarkdownProps = markdownCalls[0]?.[0];
        const secondMarkdownProps = markdownCalls[1]?.[0];
        expect(firstMarkdownProps?.markdown).toBe('assistant text');
        expect(secondMarkdownProps?.markdown).toBe('private reasoning');
        expect(toolUseViewSpy).toHaveBeenCalledTimes(1);
        const toolUseCall = (toolUseViewSpy.mock.calls as unknown as Array<Array<{ toolUse: unknown; toolResult: unknown }>>)[0];
        const toolUseProps = toolUseCall?.[0];
        expect(toolUseProps?.toolUse).toEqual(toolUse);
        expect(toolUseProps?.toolResult).toEqual(toolResult);
        expect(JSON.stringify(tree)).toContain('Thinking');
        expect(JSON.stringify(tree)).toContain('hidden');
    });
});
