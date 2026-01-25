import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const commandViewSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    StyleSheet: { create: (styles: any) => styles },
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

describe('BashView', () => {
    it('shows stdout on completed tools', async () => {
        commandViewSpy.mockReset();
        const { BashView } = await import('./BashView');

        const tool: ToolCall = {
            name: 'Bash',
            state: 'completed',
            input: { command: 'echo hi' },
            result: { stdout: 'hi\n', stderr: '' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(BashView, { tool, metadata: null } as any));
        });

        const props = commandViewSpy.mock.calls.at(-1)?.[0];
        expect(props?.stdout).toBe('hi\n');
    });

    it('treats plain string tool results as stdout', async () => {
        commandViewSpy.mockReset();
        const { BashView } = await import('./BashView');

        const tool: ToolCall = {
            name: 'Bash',
            state: 'completed',
            input: { command: 'pwd' },
            result: '/tmp\n' as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(BashView, { tool, metadata: null } as any));
        });

        const props = commandViewSpy.mock.calls.at(-1)?.[0];
        expect(props?.stdout).toBe('/tmp\n');
    });

    it('uses aggregated_output when stdout is missing', async () => {
        commandViewSpy.mockReset();
        const { BashView } = await import('./BashView');

        const tool: ToolCall = {
            name: 'Bash',
            state: 'completed',
            input: { command: 'echo hi' },
            result: { aggregated_output: 'hi\n', stderr: '' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        await act(async () => {
            renderer.create(React.createElement(BashView, { tool, metadata: null } as any));
        });

        const props = commandViewSpy.mock.calls.at(-1)?.[0];
        expect(props?.stdout).toBe('hi\n');
    });
});
