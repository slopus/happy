import type * as React from 'react';

export type SelectableMenuItem = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
    /** Used for grouping headers (optional). */
    category?: string;
    /** Optional left/right visuals (icon, shortcut chip, checkmark, etc). */
    left?: React.ReactNode;
    right?: React.ReactNode;
    disabled?: boolean;
}>;

export type SelectableMenuCategory = Readonly<{
    id: string;
    title: string;
    items: ReadonlyArray<SelectableMenuItem>;
}>;

