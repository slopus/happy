import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const markdownViewSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => {
        markdownViewSpy(props);
        return React.createElement('MarkdownView', props);
    },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('ReasoningView', () => {
    it('renders tool.result.content as markdown', async () => {
        markdownViewSpy.mockReset();
        const { ReasoningView } = await import('./ReasoningView');

        const tool: ToolCall = {
            name: 'GeminiReasoning',
            state: 'completed',
            input: { title: 'Thinking' },
            result: { content: 'Hello **world**' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(ReasoningView, { tool, metadata: null, messages: [], sessionId: 's1' }));
        });

        expect(markdownViewSpy).toHaveBeenCalled();
        const lastCall = markdownViewSpy.mock.calls.at(-1)?.[0];
        expect(lastCall?.markdown).toBe('Hello **world**');
    });
});

