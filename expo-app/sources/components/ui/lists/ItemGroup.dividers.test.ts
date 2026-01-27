import React from 'react';
import { describe, expect, it } from 'vitest';
import { withItemGroupDividers } from './ItemGroup.dividers';
import { ItemGroupRowPositionProvider } from './ItemGroupRowPosition';

type FragmentProps = {
    children?: React.ReactNode;
};

function TestItem(_props: { id: string; showDivider?: boolean }) {
    return null;
}

function collectShowDividers(node: React.ReactNode): Array<boolean | undefined> {
    const values: Array<boolean | undefined> = [];

    const walk = (n: React.ReactNode) => {
        React.Children.forEach(n, (child) => {
            if (!React.isValidElement(child)) return;
            if (child.type === React.Fragment) {
                const fragment = child as React.ReactElement<FragmentProps>;
                walk(fragment.props.children);
                return;
            }
            if (child.type === ItemGroupRowPositionProvider) {
                const provider = child as React.ReactElement<{ children?: React.ReactNode }>;
                walk(provider.props.children);
                return;
            }
            if (child.type === TestItem) {
                const element = child as React.ReactElement<{ showDivider?: boolean }>;
                values.push(element.props.showDivider);
                return;
            }
            // Ignore other element types.
        });
    };

    walk(node);
    return values;
}

describe('withItemGroupDividers', () => {
    it('treats fragment children as part of the divider sequence', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { id: 'a' }),
            React.createElement(
                React.Fragment,
                null,
                React.createElement(TestItem, { id: 'b' }),
                React.createElement(TestItem, { id: 'c' }),
            ),
        );

        const processed = withItemGroupDividers(children);
        expect(collectShowDividers(processed)).toEqual([true, true, false]);
    });

    it('preserves explicit showDivider={false} overrides', () => {
        const children = React.createElement(
            React.Fragment,
            null,
            React.createElement(TestItem, { id: 'a', showDivider: false }),
            React.createElement(TestItem, { id: 'b' }),
            React.createElement(TestItem, { id: 'c' }),
        );

        const processed = withItemGroupDividers(children);
        expect(collectShowDividers(processed)).toEqual([false, true, false]);
    });
});
