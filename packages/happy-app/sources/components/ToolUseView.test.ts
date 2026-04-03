import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pushSpy, codeViewSpy, sectionSpy, toolErrorSpy, markdownSpy } = vi.hoisted(() => ({
    pushSpy: vi.fn(),
    codeViewSpy: vi.fn(({ code }: { code: string }) => React.createElement('Text', null, code)),
    sectionSpy: vi.fn(({ title, children }: { title?: string; children: React.ReactNode }) => (
        React.createElement('View', null, title ? React.createElement('Text', null, title) : null, children)
    )),
    toolErrorSpy: vi.fn(({ message }: { message: string }) => React.createElement('Text', null, `error:${message}`)),
    markdownSpy: vi.fn(({ markdown }: { markdown: string }) => React.createElement('Text', null, markdown)),
}));
vi.mock('react-native', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    Image: (props: any) => React.createElement('Image', props),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => (typeof factory === 'function' ? factory({
            colors: {
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                modal: { border: '#ccc' },
            },
        }) : factory),
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: pushSpy }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('./CodeView', () => ({
    CodeView: codeViewSpy,
}));

vi.mock('./tools/ToolSectionView', () => ({
    ToolSectionView: sectionSpy,
}));

vi.mock('./tools/ToolError', () => ({
    ToolError: toolErrorSpy,
}));

vi.mock('./markdown/MarkdownView', () => ({
    MarkdownView: markdownSpy,
}));

import { ToolUseView } from './ToolUseView';

describe('ToolUseView', () => {
    beforeEach(() => {
        pushSpy.mockClear();
        codeViewSpy.mockClear();
        sectionSpy.mockClear();
        toolErrorSpy.mockClear();
        markdownSpy.mockClear();
    });

    it('renders completed tool input and text output', () => {
        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: {
                    id: 'tool-1',
                    name: 'Read',
                    raw_input: '{"path":"/tmp/file"}',
                    input: { path: '/tmp/file' },
                    is_input_complete: true,
                },
                toolResult: {
                    tool_use_id: 'tool-1',
                    tool_name: 'Read',
                    is_error: false,
                    content: { Text: 'file contents' },
                },
            }));
        });

        expect(codeViewSpy).toHaveBeenCalledTimes(1);
        const codeProps = codeViewSpy.mock.calls[0]?.[0] as { code: string } | undefined;
        expect(codeProps?.code).toContain('"path": "/tmp/file"');
        expect(markdownSpy).toHaveBeenCalledTimes(1);
        const markdownProps = markdownSpy.mock.calls[0]?.[0] as { markdown: string } | undefined;
        expect(markdownProps?.markdown).toBe('file contents');
    });

    it('hides tool input while the input is still streaming', () => {
        act(() => {
            create(React.createElement(ToolUseView, {
                sessionId: 'session-1',
                messageId: 'msg:1',
                toolUse: {
                    id: 'tool-1',
                    name: 'Read',
                    raw_input: '{"path":"/tmp/file"}',
                    input: { path: '/tmp/file' },
                    is_input_complete: false,
                },
            }));
        });

        expect(codeViewSpy).not.toHaveBeenCalled();
    });

    it('renders tool errors from matching SessionToolResult values', () => {
        act(() => {
            create(React.createElement(ToolUseView, {
                toolUse: {
                    id: 'tool-1',
                    name: 'Read',
                    raw_input: '{}',
                    input: {},
                    is_input_complete: true,
                },
                toolResult: {
                    tool_use_id: 'tool-1',
                    tool_name: 'Read',
                    is_error: true,
                    content: { Text: 'permission denied' },
                },
            }));
        });

        expect(toolErrorSpy).toHaveBeenCalledTimes(1);
        const errorProps = toolErrorSpy.mock.calls[0]?.[0] as { message: string } | undefined;
        expect(errorProps?.message).toBe('permission denied');
    });
});
