import React from 'react';
import { describe, expect, it } from 'vitest';
import { countSelectableItems } from './ItemGroup.selectableCount';

function TestItem(_props: { title?: React.ReactNode; onPress?: () => void; onLongPress?: () => void }) {
    return null;
}

describe('countSelectableItems', () => {
    it('counts items with ReactNode titles as selectable', () => {
        const node = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { title: React.createElement('span', null, 'X'), onPress: () => {} }),
            React.createElement(TestItem, { title: 'Y', onPress: () => {} }),
        );

        expect(countSelectableItems(node)).toBe(2);
    });

    it('does not count items with empty-string titles', () => {
        const node = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { title: '', onPress: () => {} }),
            React.createElement(TestItem, { title: 'ok', onPress: () => {} }),
        );

        expect(countSelectableItems(node)).toBe(1);
    });

    it('recurse-counts Fragment children', () => {
        const node = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { title: 'a', onPress: () => {} }),
            React.createElement(
                React.Fragment,
                null,
                React.createElement(TestItem, { title: React.createElement('span', null, 'b'), onPress: () => {} }),
                React.createElement(TestItem, { title: undefined, onPress: () => {} }),
            ),
        );

        expect(countSelectableItems(node)).toBe(2);
    });
});
