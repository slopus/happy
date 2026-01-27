import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => null,
}));

vi.mock('@/components/FloatingOverlay', () => {
    const React = require('react');
    return {
        FloatingOverlay: (props: any) => React.createElement('FloatingOverlay', props, props.children),
    };
});

vi.mock('@/components/ui/popover', () => {
    const React = require('react');
    return {
        Popover: (props: any) => {
            if (!props.open) return null;
            return React.createElement(
                'Popover',
                props,
                props.children({
                    maxHeight: 400,
                    maxWidth: 400,
                    placement: props.placement === 'auto' ? 'bottom' : (props.placement ?? 'bottom'),
                }),
            );
        },
    };
});

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: any) => React.createElement('Ionicons', props, props.children),
    };
});

vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        colors: {
            surface: '#ffffff',
            surfacePressed: '#f1f1f1',
            surfacePressedOverlay: '#f7f7f7',
            divider: 'rgba(0,0,0,0.12)',
            text: '#111111',
            textSecondary: '#666666',
            textDestructive: '#cc0000',
            deleteAction: '#cc0000',
            button: { secondary: { tint: '#111111' } },
        },
    };

    return {
        StyleSheet: { create: (factory: any) => factory(theme, {}) },
        useUnistyles: () => ({
            theme,
        }),
    };
});

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'ios', select: (m: any) => m?.ios ?? m?.default },
        InteractionManager: { runAfterInteractions: () => {} },
        useWindowDimensions: () => ({ width: 320, height: 800 }),
        StyleSheet: {
            absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

describe('ItemRowActions', () => {
    it('invokes overflow actions even when InteractionManager does not run callbacks', async () => {
        const { ItemRowActions } = await import('./ItemRowActions');
        const { SelectableRow } = await import('@/components/ui/lists/SelectableRow');

        const onEdit = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(ItemRowActions, {
                    title: 'Profile',
                    actions: [
                        { id: 'edit', title: 'Edit profile', icon: 'create-outline', onPress: onEdit },
                    ],
                }),
            );
        });

        const trigger = (tree?.root.findAllByType('Pressable' as any) ?? []).find(
            (node: any) => node.props?.accessibilityLabel === 'More actions',
        );
        expect(trigger).toBeTruthy();

        act(() => {
            trigger?.props?.onPress?.({ stopPropagation: () => {} });
        });

        const editRow = (tree?.root.findAllByType(SelectableRow as any) ?? []).find(
            (node: any) => node.props?.title === 'Edit profile',
        );
        expect(editRow).toBeTruthy();

        act(() => {
            editRow?.props?.onPress?.();
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(onEdit).toHaveBeenCalledTimes(1);
    });
});
