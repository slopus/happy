export interface FilterablePickerItem {
    key: string;
    label: string;
}

// Case-insensitive substring filter over a picker item's label and key.
// An empty/whitespace query returns the list unchanged. Used by the
// new-session path picker so typing narrows the recent-projects list.
export function filterPickerItems<T extends FilterablePickerItem>(items: T[], query: string): T[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        return items;
    }
    return items.filter((item) =>
        item.label.toLowerCase().includes(q) || item.key.toLowerCase().includes(q),
    );
}
