import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commandViewSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('@/components/CommandView', () => ({
    CommandView: (props: any) => {
        commandViewSpy(props);
        return React.createElement('CommandView', props);
    },
}));

vi.mock('../ToolFullView', () => ({
    toolFullViewStyles: {},
}));

describe('BashViewFull', () => {
    it('renders streaming stdout while running', async () => {
        commandViewSpy.mockReset();
        const { BashViewFull } = await import('./BashViewFull');

        const tool: ToolCall = {
            name: 'Bash',
            state: 'running',
            input: { command: 'echo hi' },
            result: { stdout: 'hello\n' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(BashViewFull, { tool, metadata: null }));
        });

        expect(commandViewSpy).toHaveBeenCalled();
        const lastCallArgs = commandViewSpy.mock.calls.at(-1)?.[0];
        expect(lastCallArgs?.stdout).toBe('hello\n');
    });

    it('truncates long streaming stdout while running', async () => {
        commandViewSpy.mockReset();
        const { BashViewFull } = await import('./BashViewFull');

        const long = 'x'.repeat(20000) + 'TAIL';
        const tool: ToolCall = {
            name: 'Bash',
            state: 'running',
            input: { command: 'echo hi' },
            result: { stdout: long } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(BashViewFull, { tool, metadata: null }));
        });

        expect(commandViewSpy).toHaveBeenCalled();
        const lastCallArgs = commandViewSpy.mock.calls.at(-1)?.[0];
        expect(typeof lastCallArgs?.stdout).toBe('string');
        expect(lastCallArgs.stdout.length).toBeLessThan(long.length);
        expect(lastCallArgs.stdout.endsWith('TAIL')).toBe(true);
    });
});
