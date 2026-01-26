import * as React from 'react';
import { ItemGroupRowPositionProvider } from './ItemGroupRowPosition';

type DividerChildProps = {
    showDivider?: boolean;
};

type FragmentProps = {
    children?: React.ReactNode;
};

export function withItemGroupDividers(children: React.ReactNode): React.ReactNode {
    const countNonFragmentElements = (node: React.ReactNode): number => {
        return React.Children.toArray(node).reduce<number>((count, child) => {
            if (!React.isValidElement(child)) {
                return count;
            }
            if (child.type === React.Fragment) {
                const fragment = child as React.ReactElement<FragmentProps>;
                return count + countNonFragmentElements(fragment.props.children);
            }
            return count + 1;
        }, 0);
    };

    const total = countNonFragmentElements(children);
    if (total === 0) return children;

    let index = 0;
    const apply = (node: React.ReactNode): React.ReactNode => {
        return React.Children.map(node, (child) => {
            if (!React.isValidElement(child)) {
                return child;
            }
            if (child.type === React.Fragment) {
                const fragment = child as React.ReactElement<FragmentProps>;
                return React.cloneElement(fragment, {}, apply(fragment.props.children));
            }

            const isFirst = index === 0;
            const isLast = index === total - 1;
            index += 1;

            const element = child as React.ReactElement<DividerChildProps>;
            const showDivider = !isLast && element.props.showDivider !== false;
            const wrapperKey = element.key ?? `row-${index - 1}`;
            return React.createElement(
                ItemGroupRowPositionProvider,
                { key: wrapperKey as any, value: { isFirst, isLast } },
                React.cloneElement(element, { showDivider }),
            );
        });
    };

    return apply(children);
}
