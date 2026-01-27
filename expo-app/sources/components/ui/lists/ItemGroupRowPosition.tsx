import * as React from 'react';

export type ItemGroupRowPosition = Readonly<{
    isFirst: boolean;
    isLast: boolean;
}>;

const ItemGroupRowPositionContext = React.createContext<ItemGroupRowPosition | null>(null);

export function ItemGroupRowPositionProvider(props: {
    value: ItemGroupRowPosition | null;
    children?: React.ReactNode;
}) {
    return (
        <ItemGroupRowPositionContext.Provider value={props.value}>
            {props.children}
        </ItemGroupRowPositionContext.Provider>
    );
}

/**
 * Resets any inherited ItemGroup row-position context for descendants.
 * Useful for portal/popover content (e.g. dropdown menus) where context would
 * otherwise “leak” from the trigger row.
 */
export function ItemGroupRowPositionBoundary(props: { children?: React.ReactNode }) {
    return (
        <ItemGroupRowPositionProvider value={null}>
            {props.children}
        </ItemGroupRowPositionProvider>
    );
}

export function useItemGroupRowPosition(): ItemGroupRowPosition | null {
    return React.useContext(ItemGroupRowPositionContext);
}
