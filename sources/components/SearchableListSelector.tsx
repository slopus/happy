import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { t } from '@/text';
import { StatusDot } from '@/components/StatusDot';
import { SearchHeader } from '@/components/SearchHeader';

/**
 * Configuration object for customizing the SearchableListSelector component.
 * Uses TypeScript generics to support any data type (T).
 */
export interface SelectorConfig<T> {
    // Core data accessors
    getItemId: (item: T) => string;
    getItemTitle: (item: T) => string;
    getItemSubtitle?: (item: T) => string | undefined;
    getItemIcon: (item: T) => React.ReactNode;

    // Status display (for machines: online/offline, paths: none)
    getItemStatus?: (item: T, theme: any) => {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
    } | null;

    // Display formatting (e.g., formatPathRelativeToHome for paths, displayName for machines)
    formatForDisplay: (item: T, context?: any) => string;
    parseFromDisplay: (text: string, context?: any) => T | null;

    // Filtering logic
    filterItem: (item: T, searchText: string, context?: any) => boolean;

    // UI customization
    searchPlaceholder: string;
    recentSectionTitle: string;
    favoritesSectionTitle: string;
    allSectionTitle?: string;
    noItemsMessage: string;

    // Optional features
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
    showAll?: boolean;
    allowCustomInput?: boolean;

    // Item subtitle override (for recent items, e.g., "Recently used")
    getRecentItemSubtitle?: (item: T) => string | undefined;

    // Custom icon for recent items (e.g., time-outline for recency indicator)
    getRecentItemIcon?: (item: T) => React.ReactNode;

    // Custom icon for favorite items (e.g., home directory uses home-outline instead of star-outline)
    getFavoriteItemIcon?: (item: T) => React.ReactNode;

    // Check if a favorite item can be removed (e.g., home directory can't be removed)
    canRemoveFavorite?: (item: T) => boolean;
}

/**
 * Props for the SearchableListSelector component.
 */
export interface SearchableListSelectorProps<T> {
    config: SelectorConfig<T>;
    items: T[];
    recentItems?: T[];
    favoriteItems?: T[];
    selectedItem: T | null;
    onSelect: (item: T) => void;
    onToggleFavorite?: (item: T) => void;
    context?: any; // Additional context (e.g., homeDir for paths)

    // Optional overrides
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
    searchPlacement?: 'header' | 'recent' | 'favorites' | 'all';
}

const RECENT_ITEMS_DEFAULT_VISIBLE = 5;
const STATUS_DOT_TEXT_GAP = 4;
const ITEM_SPACING_GAP = 16;

const stylesheet = StyleSheet.create((theme) => ({
    showMoreTitle: {
        textAlign: 'center',
        color: theme.colors.textLink,
    },
}));

export function SearchableListSelector<T>(props: SearchableListSelectorProps<T>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const {
        config,
        items,
        recentItems = [],
        favoriteItems = [],
        selectedItem,
        onSelect,
        onToggleFavorite,
        context,
        showFavorites = config.showFavorites !== false,
        showRecent = config.showRecent !== false,
        showSearch = config.showSearch !== false,
        searchPlacement = 'header',
    } = props;
    const showAll = config.showAll !== false;

    // Search query is intentionally decoupled from the selected value so pickers don't start pre-filtered.
    const [inputText, setInputText] = React.useState('');
    const [showAllRecent, setShowAllRecent] = React.useState(false);

    const favoriteIds = React.useMemo(() => {
        return new Set(favoriteItems.map((item) => config.getItemId(item)));
    }, [favoriteItems, config]);

    const filteredFavoriteItems = React.useMemo(() => {
        if (!inputText.trim()) return favoriteItems;
        return favoriteItems.filter((item) => config.filterItem(item, inputText, context));
    }, [favoriteItems, inputText, config, context]);

    const filteredRecentItems = React.useMemo(() => {
        const base = recentItems.filter((item) => !favoriteIds.has(config.getItemId(item)));
        if (!inputText.trim()) return base;
        return base.filter((item) => config.filterItem(item, inputText, context));
    }, [recentItems, favoriteIds, inputText, config, context]);

    const filteredItems = React.useMemo(() => {
        const base = items.filter((item) => !favoriteIds.has(config.getItemId(item)));
        if (!inputText.trim()) return base;
        return base.filter((item) => config.filterItem(item, inputText, context));
    }, [items, favoriteIds, inputText, config, context]);

    const handleInputChange = (text: string) => {
        setInputText(text);

        if (config.allowCustomInput && text.trim()) {
            const parsedItem = config.parseFromDisplay(text.trim(), context);
            if (parsedItem) onSelect(parsedItem);
        }
    };

    const renderStatus = (status: { text: string; color: string; dotColor: string; isPulsing?: boolean } | null | undefined) => {
        if (!status) return null;
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: STATUS_DOT_TEXT_GAP }}>
                <StatusDot
                    color={status.dotColor}
                    isPulsing={status.isPulsing}
                    size={6}
                />
                <Text
                    style={[
                        Typography.default('regular'),
                        {
                            fontSize: Platform.select({ ios: 17, default: 16 }),
                            letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
                            color: status.color,
                        },
                    ]}
                >
                    {status.text}
                </Text>
            </View>
        );
    };

    const renderFavoriteToggle = (item: T, isFavorite: boolean) => {
        if (!showFavorites || !onToggleFavorite) return null;

        const canRemove = config.canRemoveFavorite?.(item) ?? true;
        const disabled = isFavorite && !canRemove;
        const color = isFavorite ? theme.colors.button.primary.background : theme.colors.textSecondary;

        return (
            <Pressable
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                disabled={disabled}
                onPress={(e) => {
                    e.stopPropagation();
                    if (disabled) return;
                    onToggleFavorite(item);
                }}
            >
                <Ionicons
                    name={isFavorite ? 'star' : 'star-outline'}
                    size={20}
                    color={disabled ? theme.colors.textSecondary : color}
                />
            </Pressable>
        );
    };

    const renderItem = (item: T, isSelected: boolean, isLast: boolean, showDividerOverride?: boolean, forRecent = false, forFavorite = false) => {
        const itemId = config.getItemId(item);
        const title = config.getItemTitle(item);
        const subtitle = forRecent && config.getRecentItemSubtitle
            ? config.getRecentItemSubtitle(item)
            : config.getItemSubtitle?.(item);
        const icon = forRecent && config.getRecentItemIcon
            ? config.getRecentItemIcon(item)
            : forFavorite && config.getFavoriteItemIcon
                ? config.getFavoriteItemIcon(item)
                : config.getItemIcon(item);
        const status = config.getItemStatus?.(item, theme);
        const isFavorite = favoriteIds.has(itemId) || forFavorite;

        return (
            <Item
                key={itemId}
                title={title}
                subtitle={subtitle}
                subtitleLines={0}
                leftElement={icon}
                rightElement={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: ITEM_SPACING_GAP }}>
                        {renderStatus(status)}
                        <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons
                                name="checkmark-circle"
                                size={24}
                                color={theme.colors.button.primary.background}
                                style={{ opacity: isSelected ? 1 : 0 }}
                            />
                        </View>
                        {renderFavoriteToggle(item, isFavorite)}
                    </View>
                )}
                onPress={() => onSelect(item)}
                showChevron={false}
                selected={isSelected}
                pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                showDivider={showDividerOverride !== undefined ? showDividerOverride : !isLast}
            />
        );
    };

    const showAllRecentItems = showAllRecent || inputText.trim().length > 0;
    const recentItemsToShow = showAllRecentItems
        ? filteredRecentItems
        : filteredRecentItems.slice(0, RECENT_ITEMS_DEFAULT_VISIBLE);

    const hasRecentGroup = showRecent && filteredRecentItems.length > 0;
    const hasFavoritesGroup = showFavorites && filteredFavoriteItems.length > 0;
    const hasAllGroup = showAll && filteredItems.length > 0;

    const effectiveSearchPlacement = React.useMemo(() => {
        if (!showSearch) return 'header' as const;
        if (searchPlacement === 'recent' && !hasRecentGroup) return 'header' as const;
        if (searchPlacement === 'favorites' && !hasFavoritesGroup) return 'header' as const;
        if (searchPlacement === 'all' && !hasAllGroup) return 'header' as const;
        return searchPlacement;
    }, [hasAllGroup, hasFavoritesGroup, hasRecentGroup, searchPlacement, showSearch]);

    const searchNodeHeader = showSearch ? (
        <SearchHeader
            value={inputText}
            onChangeText={handleInputChange}
            placeholder={config.searchPlaceholder}
        />
    ) : null;

    const searchNodeEmbedded = showSearch ? (
        <SearchHeader
            value={inputText}
            onChangeText={handleInputChange}
            placeholder={config.searchPlaceholder}
            containerStyle={{
                backgroundColor: 'transparent',
                borderBottomWidth: 0,
            }}
        />
    ) : null;

    return (
        <>
            {effectiveSearchPlacement === 'header' && searchNodeHeader}

            {hasRecentGroup && (
                <ItemGroup title={config.recentSectionTitle}>
                    {effectiveSearchPlacement === 'recent' && searchNodeEmbedded}
                    {recentItemsToShow.map((item, index, arr) => {
                        const itemId = config.getItemId(item);
                        const selectedId = selectedItem ? config.getItemId(selectedItem) : null;
                        const isSelected = itemId === selectedId;
                        const isLast = index === arr.length - 1;

                        const showDivider = !isLast ||
                            (!inputText.trim() &&
                                !showAllRecent &&
                                filteredRecentItems.length > RECENT_ITEMS_DEFAULT_VISIBLE);

                        return renderItem(item, isSelected, isLast, showDivider, true, false);
                    })}

                    {!inputText.trim() && filteredRecentItems.length > RECENT_ITEMS_DEFAULT_VISIBLE && (
                        <Item
                            title={showAllRecent
                                ? t('machineLauncher.showLess')
                                : t('machineLauncher.showAll', { count: filteredRecentItems.length })
                            }
                            onPress={() => setShowAllRecent(!showAllRecent)}
                            showChevron={false}
                            showDivider={false}
                            titleStyle={styles.showMoreTitle}
                        />
                    )}
                </ItemGroup>
            )}

            {hasFavoritesGroup && (
                <ItemGroup title={config.favoritesSectionTitle}>
                    {effectiveSearchPlacement === 'favorites' && searchNodeEmbedded}
                    {filteredFavoriteItems.map((item, index) => {
                        const itemId = config.getItemId(item);
                        const selectedId = selectedItem ? config.getItemId(selectedItem) : null;
                        const isSelected = itemId === selectedId;
                        const isLast = index === filteredFavoriteItems.length - 1;
                        return renderItem(item, isSelected, isLast, !isLast, false, true);
                    })}
                </ItemGroup>
            )}

            {hasAllGroup && (
                <ItemGroup title={config.allSectionTitle ?? config.recentSectionTitle.replace('Recent ', 'All ')}>
                    {effectiveSearchPlacement === 'all' && searchNodeEmbedded}
                    {filteredItems.map((item, index) => {
                        const itemId = config.getItemId(item);
                        const selectedId = selectedItem ? config.getItemId(selectedItem) : null;
                        const isSelected = itemId === selectedId;
                        const isLast = index === filteredItems.length - 1;
                        return renderItem(item, isSelected, isLast, !isLast, false, false);
                    })}
                </ItemGroup>
            )}
        </>
    );
}
