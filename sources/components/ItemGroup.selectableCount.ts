import * as React from 'react';

type ItemChildProps = {
    title?: unknown;
    onPress?: unknown;
    onLongPress?: unknown;
};

export function countSelectableItems(node: React.ReactNode): number {
    return React.Children.toArray(node).reduce<number>((count, child) => {
        if (!React.isValidElement(child)) {
            return count;
        }
        if (child.type === React.Fragment) {
            const fragment = child as React.ReactElement<{ children?: React.ReactNode }>;
            return count + countSelectableItems(fragment.props.children);
        }
        const propsAny = (child as React.ReactElement<ItemChildProps>).props as any;
        const title = propsAny?.title;
        const hasTitle = title !== null && title !== undefined && title !== '';
        const isSelectable = typeof propsAny?.onPress === 'function' || typeof propsAny?.onLongPress === 'function';
        return count + (hasTitle && isSelectable ? 1 : 0);
    }, 0);
}
