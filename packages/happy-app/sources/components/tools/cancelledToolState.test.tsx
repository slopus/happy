import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { ToolStatusIndicator } from './ToolStatusIndicator';
import { TaskView } from './views/TaskView';
import { knownTools } from './knownTools';
import type { Message, ToolCall } from '@/sync/typesMessage';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'android' },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: '#accent', warning: '#warning', success: '#success',
                textDestructive: '#destructive', textSecondary: '#secondary',
            },
        },
    }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ConversationActivityStrip', () => ({
    ConversationActivityStrip: 'ConversationActivityStrip',
}));

const cancelledTool: ToolCall = {
    callId: 'cancelled-call', name: 'UnknownTool', state: 'cancelled', input: {},
    createdAt: 1, startedAt: 1, completedAt: 2, description: 'Cancelled child',
    cancellationReason: 'Stopped by user',
};

const cancelledMessage: Message = {
    kind: 'tool-call', id: 'cancelled-message', localId: null, createdAt: 1,
    tool: cancelledTool, children: [],
};

describe('cancelled tool UI semantics', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => consoleErrorSpy.mockRestore());

    it('renders the neutral translated cancellation indicator', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<ToolStatusIndicator tool={cancelledTool} />); });
        expect(renderer.root.findByType('Ionicons').props).toMatchObject({
            name: 'remove-circle-outline',
            color: '#secondary',
            accessibilityLabel: 'toolGroup.subagentStatus.cancelled',
        });
        act(() => renderer.unmount());
    });

    it('includes a cancelled child in TaskView with the same neutral semantic token', () => {
        const parent = { ...cancelledTool, callId: 'parent-call', name: 'Task', state: 'running' as const };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <TaskView tool={parent} metadata={null} messages={[cancelledMessage]} sessionId="session-1" />,
            );
        });
        expect(renderer.root.findAllByType('Text').some((node: any) => (
            node.children.includes('UnknownTool')
        ))).toBe(true);
        expect(renderer.root.findByType('Ionicons').props).toMatchObject({
            name: 'remove-circle-outline',
            color: '#secondary',
            accessibilityLabel: 'toolGroup.subagentStatus.cancelled',
        });
        act(() => renderer.unmount());
    });

    it('keeps a Task card non-minimal when its only child tool was cancelled', () => {
        const minimal = (knownTools.Task as any).minimal({
            metadata: null,
            tool: { ...cancelledTool, name: 'Task' },
            messages: [cancelledMessage],
        });
        expect(minimal).toBe(false);
    });
});
