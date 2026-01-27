import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.useFakeTimers();
vi.clearAllMocks();

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#fff' },
                text: '#000',
                textSecondary: '#666',
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

const modalShow = vi.fn();
vi.mock('@/modal', () => ({
    Modal: {
        show: (...args: any[]) => modalShow(...args),
    },
}));

vi.mock('./PendingMessagesModal', () => ({
    PendingMessagesModal: 'PendingMessagesModal',
}));

describe('PendingQueueIndicator', () => {
    const cleanupTimers = () => {
        vi.clearAllTimers();
    };

    it('renders null when count is 0', async () => {
        const { PendingQueueIndicator } = await import('./PendingQueueIndicator');
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingQueueIndicator, { sessionId: 's1', count: 0 }));
        });
        expect(tree!.toJSON()).toBeNull();
        tree!.unmount();
        cleanupTimers();
    });

    it('renders a preview when provided', async () => {
        const { PendingQueueIndicator } = await import('./PendingQueueIndicator');
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PendingQueueIndicator, {
                    sessionId: 's1',
                    count: 2,
                    preview: 'next up: hello',
                } as any)
            );
        });

        await act(async () => {
            vi.advanceTimersByTime(250);
        });

        const texts = tree!.root.findAllByType('Text' as any).map((n) => n.props.children).flat();
        expect(texts.join(' ')).toContain('next up: hello');
        tree!.unmount();
        cleanupTimers();
    });

    it('constrains width to layout.maxWidth', async () => {
        const { PendingQueueIndicator } = await import('./PendingQueueIndicator');
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(PendingQueueIndicator, {
                    sessionId: 's1',
                    count: 1,
                } as any)
            );
        });

        await act(async () => {
            vi.advanceTimersByTime(250);
        });

        const views = tree!.root.findAllByType('View' as any);
        const hasMaxWidthContainer = views.some((v) => {
            const style = v.props.style;
            return style && style.maxWidth === 800 && style.width === '100%';
        });
        expect(hasMaxWidthContainer).toBe(true);

        const pressable = tree!.root.findByType('Pressable' as any);
        const style = pressable.props.style({ pressed: false });
        expect(style.width).toBe('100%');
        tree!.unmount();
        cleanupTimers();
    });

    it('does not flicker pending UI for fast enqueue→dequeue transitions', async () => {
        const { PendingQueueIndicator } = await import('./PendingQueueIndicator');
        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PendingQueueIndicator, { sessionId: 's1', count: 0 }));
        });
        expect(tree!.toJSON()).toBeNull();

        await act(async () => {
            tree!.update(React.createElement(PendingQueueIndicator, { sessionId: 's1', count: 1, preview: 'hello' }));
        });
        // Still hidden until debounce elapses.
        expect(tree!.toJSON()).toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(50);
            tree!.update(React.createElement(PendingQueueIndicator, { sessionId: 's1', count: 0 }));
        });
        // If the pending queue drains quickly, we should never render.
        expect(tree!.toJSON()).toBeNull();
        tree!.unmount();
        cleanupTimers();
    });
});
