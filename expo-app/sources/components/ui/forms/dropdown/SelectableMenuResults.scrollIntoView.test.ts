import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollIntoViewSpy = vi.fn();

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web' },
        Text: (props: any) => React.createElement('Text', props, props.children),
        View: React.forwardRef((props: any, ref: any) => {
            React.useImperativeHandle(ref, () => ({ scrollIntoView: scrollIntoViewSpy }));
            return React.createElement('View', props, props.children);
        }),
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/lists/SelectableRow', () => {
    const React = require('react');
    return {
        SelectableRow: (props: any) => React.createElement('SelectableRow', props, props.children),
    };
});

vi.mock('@/components/ui/lists/Item', () => {
    const React = require('react');
    return {
        Item: (props: any) => React.createElement('Item', props, props.children),
    };
});

vi.mock('@/components/ui/lists/ItemGroup', () => {
    const React = require('react');
    return {
        ItemGroupSelectionContext: {
            Provider: (props: any) => React.createElement('ItemGroupSelectionContextProvider', props, props.children),
        },
    };
});

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => {
    const React = require('react');
    return {
        ItemGroupRowPositionBoundary: (props: any) => React.createElement('ItemGroupRowPositionBoundary', props, props.children),
    };
});

describe('SelectableMenuResults (web)', () => {
    it('does not call DOM scrollIntoView (prevents scrolling the underlying page when opening dropdowns)', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const categories = [
            {
                id: 'general',
                title: 'General',
                items: [
                    { id: 'a', title: 'A', disabled: false, left: null, right: null },
                    { id: 'b', title: 'B', disabled: false, left: null, right: null },
                ],
            },
        ] as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(SelectableMenuResults, {
                    categories,
                    selectedIndex: 0,
                    onSelectionChange: () => {},
                    onPressItem: () => {},
                    rowVariant: 'slim',
                    emptyLabel: 'empty',
                    rowKind: 'item',
                }),
            );
        });

        act(() => {
            tree?.update(
                React.createElement(SelectableMenuResults, {
                    categories,
                    selectedIndex: 1,
                    onSelectionChange: () => {},
                    onPressItem: () => {},
                    rowVariant: 'slim',
                    emptyLabel: 'empty',
                    rowKind: 'item',
                }),
            );
        });

        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });
});
