import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commandViewSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                surfaceHigh: '#fff',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/CommandView', () => ({
    CommandView: (props: any) => {
        commandViewSpy(props);
        return React.createElement('CommandView', props);
    },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('GeminiExecuteView', () => {
    it('renders structured stdout when tool result includes stdout', async () => {
        commandViewSpy.mockReset();
        const { GeminiExecuteView } = await import('./GeminiExecuteView');

        const tool: ToolCall = {
            name: 'execute',
            state: 'completed',
            input: {
                toolCall: {
                    title: 'echo hi [current working directory /tmp] (desc)',
                },
            },
            result: { stdout: 'hi\n' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(GeminiExecuteView, { tool, metadata: null, messages: [], sessionId: 'test-session' }),
            );
        });

        expect(commandViewSpy).toHaveBeenCalled();
        const lastCallArgs = commandViewSpy.mock.calls.at(-1)?.[0];
        expect(lastCallArgs?.stdout).toBe('hi\n');
        expect(typeof lastCallArgs?.command).toBe('string');
        expect(lastCallArgs?.command).toContain('echo hi');
    });

    it('renders string tool result as stdout fallback', async () => {
        commandViewSpy.mockReset();
        const { GeminiExecuteView } = await import('./GeminiExecuteView');

        const tool: ToolCall = {
            name: 'execute',
            state: 'completed',
            input: { command: 'echo hi' },
            result: 'hi\n' as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(
                React.createElement(GeminiExecuteView, { tool, metadata: null, messages: [], sessionId: 'test-session' }),
            );
        });

        expect(commandViewSpy).toHaveBeenCalled();
        const lastCallArgs = commandViewSpy.mock.calls.at(-1)?.[0];
        expect(lastCallArgs?.stdout).toBe('hi\n');
    });
});
