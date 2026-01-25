import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('TodoView', () => {
    it('renders todos from TodoRead result.todos', async () => {
        const { TodoView } = await import('./TodoView');

        const tool: ToolCall = {
            name: 'TodoRead',
            state: 'completed',
            input: {},
            result: { todos: [{ content: 'Hello', status: 'pending' }] } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(TodoView, { tool, metadata: null, messages: [] } as any));
        });

        const texts = tree!.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        const flattened = texts.flatMap((c: any) => Array.isArray(c) ? c : [c]).filter((c: any) => typeof c === 'string');
        expect(flattened.join(' ')).toContain('Hello');
    });
});

