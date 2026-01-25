import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('ItemGroupTitleWithAction', () => {
    it('renders the action button immediately after the title', async () => {
        const { ItemGroupTitleWithAction } = await import('./ItemGroupTitleWithAction');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(ItemGroupTitleWithAction, {
                title: 'Detected CLIs',
                titleStyle: { color: '#000' },
                action: {
                    accessibilityLabel: 'Refresh',
                    iconName: 'refresh',
                    iconColor: '#666',
                    onPress: vi.fn(),
                },
            }));
        });

        const rootView = tree!.root.findByType('View' as any);
        const children = React.Children.toArray(rootView.props.children) as any[];
        expect(children.map((c) => c.type)).toEqual(['Text', 'Pressable']);
        expect(children[0]?.props?.children).toBe('Detected CLIs');
    });
});
