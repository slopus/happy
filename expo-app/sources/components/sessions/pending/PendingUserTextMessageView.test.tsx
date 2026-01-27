import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (fn: any) => fn({ colors: { userMessageBackground: '#eee' } }) },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#fff' },
                textSecondary: '#666',
                userMessageBackground: '#eee',
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: 'MarkdownView',
}));

const modalShow = vi.fn();
vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: any[]) => modalShow(...args),
    },
}));

vi.mock('./PendingMessagesModal', () => ({
    PendingMessagesModal: 'PendingMessagesModal',
}));

describe('PendingUserTextMessageView', () => {
    it('renders a badge with a pending count when there are other pending messages', async () => {
        const { PendingUserTextMessageView } = await import('./PendingUserTextMessageView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PendingUserTextMessageView, {
                    sessionId: 's1',
                    otherPendingCount: 2,
                    message: {
                        id: 'p1',
                        localId: 'p1',
                        createdAt: 1,
                        updatedAt: 1,
                        text: 'hello',
                        rawRecord: {} as any,
                    },
                } as any),
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        expect(pressables.some((p) => p.props.accessibilityLabel === 'Pending (+2)')).toBe(true);

        tree!.unmount();
    });
});

