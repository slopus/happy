import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web' },
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextInput: (props: any) => React.createElement('TextInput', props, props.children),
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => {
        const React = require('react');
        return React.createElement('Ionicons', props);
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                divider: '#ddd',
                text: '#111',
            },
        },
    }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        const React = require('react');
        return React.createElement(
            'Popover',
            props,
            typeof props.children === 'function'
                ? props.children({ maxHeight: 200, maxWidth: 400, placement: props.placement ?? 'bottom' })
                : props.children,
        );
    },
}));

vi.mock('@/components/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => {
        const React = require('react');
        return React.createElement('FloatingOverlay', props, props.children);
    },
}));

vi.mock('@/components/ui/forms/dropdown/useSelectableMenu', () => ({
    useSelectableMenu: () => ({
        searchQuery: '',
        selectedIndex: 0,
        filteredCategories: [],
        inputRef: { current: null },
        setSelectedIndex: () => {},
        handleSearchChange: () => {},
        handleKeyPress: () => {},
    }),
}));

vi.mock('@/components/ui/forms/dropdown/SelectableMenuResults', () => ({
    SelectableMenuResults: (props: any) => {
        const React = require('react');
        return React.createElement('SelectableMenuResults', props);
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('DropdownMenu', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
            cb();
            return 0 as any;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('provides a toggle handler to the trigger and uses it to open/close', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const { Pressable, Text } = await import('react-native');

        const onOpenChange = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(DropdownMenu, {
                    open: false,
                    onOpenChange,
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: ({ toggle }: any) =>
                        React.createElement(
                            Pressable,
                            { onPress: toggle },
                            React.createElement(Text, null, 'Trigger'),
                        ),
                }),
            );
        });

        const pressable = tree?.root.findByType(Pressable);
        expect(pressable).toBeTruthy();

        act(() => {
            pressable?.props?.onPress?.();
        });
        expect(onOpenChange).toHaveBeenCalledWith(true);

        act(() => {
            tree?.update(
                React.createElement(DropdownMenu, {
                    open: true,
                    onOpenChange,
                    items: [{ id: 'a', title: 'A' }],
                    onSelect: () => {},
                    trigger: ({ toggle }: any) =>
                        React.createElement(
                            Pressable,
                            { onPress: toggle },
                            React.createElement(Text, null, 'Trigger'),
                        ),
                }),
            );
        });

        const pressable2 = tree?.root.findByType(Pressable);
        act(() => {
            pressable2?.props?.onPress?.();
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});
