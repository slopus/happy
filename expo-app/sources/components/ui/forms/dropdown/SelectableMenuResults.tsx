import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SelectableRow, type SelectableRowVariant } from '@/components/ui/lists/SelectableRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';
import type { SelectableMenuCategory, SelectableMenuItem } from './selectableMenuTypes';

const stylesheet = StyleSheet.create(() => ({
    container: {
        paddingVertical: 0,
    },
    emptyContainer: {
        padding: 48,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 15,
        color: '#999',
        letterSpacing: -0.2,
        ...Typography.default(),
    },
    categoryTitle: {
        paddingHorizontal: 32,
        paddingTop: 16,
        paddingBottom: 8,
        fontSize: 12,
        color: '#999',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
}));

export function SelectableMenuResults(props: {
    categories: ReadonlyArray<SelectableMenuCategory>;
    selectedIndex: number;
    onSelectionChange: (index: number) => void;
    onPressItem: (item: SelectableMenuItem) => void;
    rowVariant: SelectableRowVariant;
    emptyLabel: string;
    showCategoryTitles?: boolean;
    rowKind?: 'selectableRow' | 'item';
}) {
    const styles = stylesheet;
    const itemRefs = React.useRef<Record<number, View | null>>({});

    const allItems = React.useMemo(() => props.categories.flatMap((c) => c.items), [props.categories]);

    if (props.categories.length === 0 || allItems.length === 0) {
        return (
            <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>
                    {props.emptyLabel}
                </Text>
            </View>
        );
    }

    let currentIndex = 0;
    const showCategoryTitles = props.showCategoryTitles !== false;
    const rowKind = props.rowKind ?? 'selectableRow';

    const content = (
        <View style={styles.container}>
            {props.categories.map((category) => {
                if (category.items.length === 0) return null;

                const categoryStartIndex = currentIndex;
                const categoryItems = category.items.map((item, idx) => {
                    const itemIndex = categoryStartIndex + idx;
                    const isSelected = itemIndex === props.selectedIndex;
                    currentIndex++;
                    return (
                        <View
                            key={item.id}
                            ref={(ref) => { itemRefs.current[itemIndex] = ref; }}
                        >
                            {rowKind === 'item' ? (
                                <Item
                                    title={item.title}
                                    subtitle={item.subtitle}
                                    icon={item.left}
                                    rightElement={item.right}
                                    selected={isSelected}
                                    disabled={item.disabled}
                                    showChevron={false}
                                    showDivider={false}
                                    onPress={() => {
                                        if (item.disabled) return;
                                        props.onPressItem(item);
                                    }}
                                />
                            ) : (
                                <SelectableRow
                                    variant={props.rowVariant}
                                    selected={isSelected}
                                    disabled={item.disabled}
                                    left={item.left}
                                    right={item.right}
                                    title={item.title}
                                    subtitle={item.subtitle}
                                    onPress={() => {
                                        if (item.disabled) return;
                                        props.onPressItem(item);
                                    }}
                                    onHover={() => {
                                        if (item.disabled) return;
                                        props.onSelectionChange(itemIndex);
                                    }}
                                />
                            )}
                        </View>
                    );
                });

                return (
                    <View key={category.id}>
                        {showCategoryTitles ? (
                            <Text style={styles.categoryTitle}>
                                {category.title}
                            </Text>
                        ) : null}
                        {categoryItems}
                    </View>
                );
            })}
        </View>
    );

    if (rowKind === 'item') {
        // Ensure Item's "selected row background" behavior is enabled,
        // and prevent row-position context from leaking into the popover.
        return (
            <ItemGroupRowPositionBoundary>
                <ItemGroupSelectionContext.Provider value={{ selectableItemCount: 2 }}>
                    {content}
                </ItemGroupSelectionContext.Provider>
            </ItemGroupRowPositionBoundary>
        );
    }

    return content;
}
