import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const sessionInteractionRespond = vi.fn();

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { primary: { background: '#00f', tint: '#fff' } },
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                input: { background: '#fff', placeholder: '#aaa', text: '#000' },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('../ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/sync/ops', () => ({
    sessionDeny: (...args: any[]) => sessionDeny(...args),
    sessionInteractionRespond: (...args: any[]) => sessionInteractionRespond(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: any[]) => sendMessage(...args),
    },
}));

describe('AskUserQuestionView', () => {
    beforeEach(() => {
        sessionDeny.mockReset();
        sendMessage.mockReset();
        sessionInteractionRespond.mockReset();
    });

    it('submits answers via interaction RPC without sending a follow-up user message', async () => {
        sessionInteractionRespond.mockResolvedValueOnce(undefined);

        const { AskUserQuestionView } = await import('./AskUserQuestionView');

        const tool: ToolCall = {
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'Pick one',
                        multiSelect: false,
                        options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
                    },
                ],
            },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: { id: 'toolu_1', status: 'pending' },
        };

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(AskUserQuestionView, { tool, sessionId: 's1', metadata: null, messages: [] }),
            );
        });

        // Select the first option.
        await act(async () => {
            const touchables = tree!.root.findAllByType('TouchableOpacity' as any);
            await touchables[0].props.onPress();
        });

        // Press submit (last touchable in this view).
        await act(async () => {
            const touchables = tree!.root.findAllByType('TouchableOpacity' as any);
            await touchables[touchables.length - 1].props.onPress();
        });

        expect(sessionInteractionRespond).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });
});
