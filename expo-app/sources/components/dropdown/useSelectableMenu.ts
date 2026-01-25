import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import type { SelectableMenuCategory, SelectableMenuItem } from './selectableMenuTypes';
import { t } from '@/text';

function toCategoryId(title: string): string {
    return title.toLowerCase().replace(/\s+/g, '-');
}

function groupByCategory(items: ReadonlyArray<SelectableMenuItem>, defaultCategory: string): SelectableMenuCategory[] {
    const grouped = items.reduce((acc, item) => {
        const category = item.category || defaultCategory;
        if (!acc[category]) acc[category] = [];
        acc[category]!.push(item);
        return acc;
    }, {} as Record<string, SelectableMenuItem[]>);

    return Object.entries(grouped).map(([title, groupedItems]) => ({
        id: toCategoryId(title),
        title,
        items: groupedItems,
    }));
}

export function useSelectableMenu(params: {
    items: ReadonlyArray<SelectableMenuItem>;
    onRequestClose: () => void;
    initialSelectedId?: string | null;
}) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<TextInput>(null);

    const allItemsRaw = useMemo(() => params.items, [params.items]);
    const defaultCategoryTitle = t('dropdown.category.general');
    const resultsCategoryTitle = t('dropdown.category.results');

    const filteredCategories = useMemo((): SelectableMenuCategory[] => {
        const query = searchQuery.trim().toLowerCase();

        if (!query) {
            return groupByCategory(allItemsRaw, defaultCategoryTitle);
        }

        const filtered = allItemsRaw.filter((item) => {
            const titleMatch = item.title.toLowerCase().includes(query);
            const subtitleMatch = item.subtitle?.toLowerCase().includes(query) ?? false;
            return titleMatch || subtitleMatch;
        });

        if (filtered.length === 0) return [];
        return groupByCategory(filtered, resultsCategoryTitle);
    }, [allItemsRaw, defaultCategoryTitle, resultsCategoryTitle, searchQuery]);

    const allItems = useMemo(() => {
        return filteredCategories.flatMap((c) => c.items);
    }, [filteredCategories]);

    const firstEnabledIndex = useCallback((): number => {
        for (let i = 0; i < allItems.length; i += 1) {
            if (!allItems[i]?.disabled) return i;
        }
        return 0;
    }, [allItems]);

    const isEnabledIndex = useCallback((idx: number) => {
        const item = allItems[idx];
        return Boolean(item && !item.disabled);
    }, [allItems]);

    const clampToEnabled = useCallback((idx: number): number => {
        if (allItems.length === 0) return 0;
        if (idx < 0 || idx >= allItems.length) return firstEnabledIndex();
        if (isEnabledIndex(idx)) return idx;
        return firstEnabledIndex();
    }, [allItems.length, firstEnabledIndex, isEnabledIndex]);

    // Initialize / reset selection when the query or available items change.
    useEffect(() => {
        const preferredId = params.initialSelectedId ?? null;
        if (preferredId) {
            const idx = allItems.findIndex((i) => i.id === preferredId);
            if (idx >= 0 && isEnabledIndex(idx)) {
                setSelectedIndex(idx);
                return;
            }
        }
        setSelectedIndex(firstEnabledIndex());
    }, [allItems, firstEnabledIndex, isEnabledIndex, params.initialSelectedId, searchQuery]);

    const moveSelection = useCallback((dir: -1 | 1) => {
        if (allItems.length === 0) return;
        let next = selectedIndex;
        for (let step = 0; step < allItems.length; step += 1) {
            next = Math.min(allItems.length - 1, Math.max(0, next + dir));
            if (isEnabledIndex(next)) {
                setSelectedIndex(next);
                return;
            }
        }
    }, [allItems.length, isEnabledIndex, selectedIndex]);

    const handleKeyPress = useCallback((key: string, onActivate: (item: SelectableMenuItem) => void) => {
        switch (key) {
            case 'Escape':
                params.onRequestClose();
                break;
            case 'ArrowDown':
                moveSelection(1);
                break;
            case 'ArrowUp':
                moveSelection(-1);
                break;
            case 'Enter':
                if (isEnabledIndex(selectedIndex) && allItems[selectedIndex]) {
                    onActivate(allItems[selectedIndex]!);
                }
                break;
        }
    }, [allItems, isEnabledIndex, moveSelection, params, selectedIndex]);

    const handleSearchChange = useCallback((text: string) => setSearchQuery(text), []);

    return {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleKeyPress,
        setSelectedIndex: (idx: number) => setSelectedIndex(clampToEnabled(idx)),
    };
}
