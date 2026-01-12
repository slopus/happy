import * as React from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { MultiTextInput } from '@/components/MultiTextInput';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StatusDot } from '@/components/StatusDot';

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
    noItemsMessage: string;

    // Optional features
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
    allowCustomInput?: boolean;

    // Item subtitle override (for recent items, e.g., "Recently used")
    getRecentItemSubtitle?: (item: T) => string | undefined;

    // Custom icon for recent items (e.g., time-outline for recency indicator)
    getRecentItemIcon?: (item: T) => React.ReactNode;

    // Custom icon for favorite items (e.g., home directory uses home-outline instead of star-outline)
    getFavoriteItemIcon?: (item: T) => React.ReactNode;

    // Check if a favorite item can be removed (e.g., home directory can't be removed)
    canRemoveFavorite?: (item: T) => boolean;

    // Visual customization
    compactItems?: boolean; // Use reduced padding for more compact lists (default: false)
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
    context?: any;  // Additional context (e.g., homeDir for paths)

    // Optional overrides
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;

    // Controlled collapse states (optional - defaults to uncontrolled internal state)
    collapsedSections?: {
        recent?: boolean;
        favorites?: boolean;
        all?: boolean;
    };
    onCollapsedSectionsChange?: (collapsed: { recent?: boolean; favorites?: boolean; all?: boolean }) => void;
}

const RECENT_ITEMS_DEFAULT_VISIBLE = 5;
// Spacing constants (match existing codebase patterns)
const STATUS_DOT_TEXT_GAP = 4; // Gap between StatusDot and text (used throughout app for status indicators)
const ITEM_SPACING_GAP = 4; // Gap between elements and spacing between items (compact)
const COMPACT_ITEM_PADDING = 4; // Vertical padding for compact lists
// Border radius constants (consistent rounding)
const INPUT_BORDER_RADIUS = 10; // Input field and containers
const BUTTON_BORDER_RADIUS = 8; // Buttons and actionable elements
// ITEM_BORDER_RADIUS must match ItemGroup's contentContainer borderRadius to prevent clipping
// ItemGroup uses Platform.select({ ios: 10, default: 16 })
const ITEM_BORDER_RADIUS = Platform.select({ ios: 10, default: 16 }); // Match ItemGroup container radius

const stylesheet = StyleSheet.create((theme) => ({
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    inputWrapper: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
        borderRadius: INPUT_BORDER_RADIUS,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    inputInner: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
    },
    inputField: {
        flex: 1,
    },
    clearButton: {
        width: 20,
        height: 20,
        borderRadius: INPUT_BORDER_RADIUS,
        backgroundColor: theme.colors.textSecondary,
        justifyContent: 'center',
        alignItems: 'center',
        marginLeft: 8,
    },
    favoriteButton: {
        borderRadius: BUTTON_BORDER_RADIUS,
        padding: 8,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    sectionHeaderText: {
        fontSize: 13,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default(),
    },
    selectedItemStyle: {
        borderWidth: 2,
        borderColor: theme.colors.button.primary.tint,
        borderRadius: ITEM_BORDER_RADIUS,
    },
    compactItemStyle: {
        paddingVertical: COMPACT_ITEM_PADDING,
        minHeight: 0, // Override Item's default minHeight (44-56px) for compact mode
    },
    itemBackground: {
        backgroundColor: theme.colors.input.background,
        borderRadius: ITEM_BORDER_RADIUS,
        marginBottom: ITEM_SPACING_GAP,
    },
    showMoreTitle: {
        textAlign: 'center',
        color: theme.colors.button.primary.tint,
    },
}));

/**
 * Generic searchable list selector component with recent items, favorites, and filtering.
 *
 * Pattern extracted from Working Directory section in new session wizard.
 * Supports any data type through TypeScript generics and configuration object.
 *
 * Features:
 * - Search/filter with smart skip (doesn't filter when input matches selection)
 * - Recent items with "Show More" toggle
 * - Favorites with add/remove
 * - Collapsible sections
 * - Custom input support (optional)
 *
 * @example
 * // For machines:
 * <SearchableListSelector<Machine>
 *   config={machineConfig}
 *   items={machines}
 *   recentItems={recentMachines}
 *   favoriteItems={favoriteMachines}
 *   selectedItem={selectedMachine}
 *   onSelect={(machine) => setSelectedMachine(machine)}
 *   onToggleFavorite={(machine) => toggleFavorite(machine.id)}
 * />
 *
 * // For paths:
 * <SearchableListSelector<string>
 *   config={pathConfig}
 *   items={allPaths}
 *   recentItems={recentPaths}
 *   favoriteItems={favoritePaths}
 *   selectedItem={selectedPath}
 *   onSelect={(path) => setSelectedPath(path)}
 *   onToggleFavorite={(path) => toggleFavorite(path)}
 *   context={{ homeDir }}
 * />
 */
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
        collapsedSections,
        onCollapsedSectionsChange,
    } = props;

    // Use controlled state if provided, otherwise use internal state
    const isControlled = collapsedSections !== undefined && onCollapsedSectionsChange !== undefined;

    // State management (matches Working Directory pattern)
    const [inputText, setInputText] = React.useState(() => {
        if (selectedItem) {
            return config.formatForDisplay(selectedItem, context);
        }
        return '';
    });
    const [showAllRecent, setShowAllRecent] = React.useState(false);

    // Internal uncontrolled state (used when not controlled from parent)
    const [internalShowRecentSection, setInternalShowRecentSection] = React.useState(false);
    const [internalShowFavoritesSection, setInternalShowFavoritesSection] = React.useState(false);
    const [internalShowAllItemsSection, setInternalShowAllItemsSection] = React.useState(true);

    // Use controlled or uncontrolled state
    const showRecentSection = isControlled ? !collapsedSections?.recent : internalShowRecentSection;
    const showFavoritesSection = isControlled ? !collapsedSections?.favorites : internalShowFavoritesSection;
    const showAllItemsSection = isControlled ? !collapsedSections?.all : internalShowAllItemsSection;

    // Toggle handlers that work for both controlled and uncontrolled
    const toggleRecentSection = () => {
        if (isControlled) {
            onCollapsedSectionsChange?.({ ...collapsedSections, recent: !collapsedSections?.recent });
        } else {
            setInternalShowRecentSection(!internalShowRecentSection);
        }
    };

    const toggleFavoritesSection = () => {
        if (isControlled) {
            onCollapsedSectionsChange?.({ ...collapsedSections, favorites: !collapsedSections?.favorites });
        } else {
            setInternalShowFavoritesSection(!internalShowFavoritesSection);
        }
    };

    const toggleAllItemsSection = () => {
        if (isControlled) {
            onCollapsedSectionsChange?.({ ...collapsedSections, all: !collapsedSections?.all });
        } else {
            setInternalShowAllItemsSection(!internalShowAllItemsSection);
        }
    };

    // Track if user is actively typing (vs clicking from list) to control expansion behavior
    const isUserTyping = React.useRef(false);

    // Update input text when selected item changes externally
    React.useEffect(() => {
        if (selectedItem && !isUserTyping.current) {
            setInputText(config.formatForDisplay(selectedItem, context));
        }
    }, [selectedItem, config, context]);

    // Filtering logic with smart skip (matches Working Directory pattern)
    const filteredRecentItems = React.useMemo(() => {
        if (!inputText.trim()) return recentItems;

        // Don't filter if text matches the currently selected item (user clicked from list)
        const selectedDisplayText = selectedItem ? config.formatForDisplay(selectedItem, context) : null;
        if (selectedDisplayText && inputText === selectedDisplayText) {
            return recentItems; // Show all items, don't filter
        }

        // User is typing - filter the list
        return recentItems.filter(item => config.filterItem(item, inputText, context));
    }, [recentItems, inputText, selectedItem, config, context]);

    const filteredFavoriteItems = React.useMemo(() => {
        if (!inputText.trim()) return favoriteItems;

        const selectedDisplayText = selectedItem ? config.formatForDisplay(selectedItem, context) : null;
        if (selectedDisplayText && inputText === selectedDisplayText) {
            return favoriteItems; // Show all favorites, don't filter
        }

        // Don't filter if text matches a favorite (user clicked from list)
        if (favoriteItems.some(item => config.formatForDisplay(item, context) === inputText)) {
            return favoriteItems; // Show all favorites, don't filter
        }

        return favoriteItems.filter(item => config.filterItem(item, inputText, context));
    }, [favoriteItems, inputText, selectedItem, config, context]);

    // Check if current input can be added to favorites
    const canAddToFavorites = React.useMemo(() => {
        if (!onToggleFavorite || !inputText.trim()) return false;

        // Parse input to see if it's a valid item
        const parsedItem = config.parseFromDisplay(inputText.trim(), context);
        if (!parsedItem) return false;

        // Check if already in favorites
        const parsedId = config.getItemId(parsedItem);
        return !favoriteItems.some(fav => config.getItemId(fav) === parsedId);
    }, [inputText, favoriteItems, config, context, onToggleFavorite]);

    // Handle input text change
    const handleInputChange = (text: string) => {
        isUserTyping.current = true; // User is actively typing
        setInputText(text);

        // If allowCustomInput, try to parse and select
        if (config.allowCustomInput && text.trim()) {
            const parsedItem = config.parseFromDisplay(text.trim(), context);
            if (parsedItem) {
                onSelect(parsedItem);
            }
        }
    };

    // Handle item selection from list
    const handleSelectItem = (item: T) => {
        isUserTyping.current = false; // User clicked from list
        setInputText(config.formatForDisplay(item, context));
        onSelect(item);
    };

    // Handle clear button
    const handleClear = () => {
        isUserTyping.current = false;
        setInputText('');
        // Don't clear selection - just clear input
    };

    // Handle add to favorites
    const handleAddToFavorites = () => {
        if (!canAddToFavorites || !onToggleFavorite) return;

        const parsedItem = config.parseFromDisplay(inputText.trim(), context);
        if (parsedItem) {
            onToggleFavorite(parsedItem);
        }
    };

    // Handle remove from favorites
    const handleRemoveFavorite = (item: T) => {
        if (!onToggleFavorite) return;

        Modal.alert(
            'Remove Favorite',
            `Remove "${config.getItemTitle(item)}" from ${config.favoritesSectionTitle.toLowerCase()}?`,
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: () => onToggleFavorite(item)
                }
            ]
        );
    };

    // Render status with StatusDot (DRY helper - matches Item.tsx detail style)
    const renderStatus = (status: { text: string; color: string; dotColor: string; isPulsing?: boolean } | null | undefined) => {
        if (!status) return null;
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: STATUS_DOT_TEXT_GAP }}>
                <StatusDot
                    color={status.dotColor}
                    isPulsing={status.isPulsing}
                    size={6}
                />
                <Text style={[
                    Typography.default('regular'),
                    {
                        fontSize: Platform.select({ ios: 17, default: 16 }),
                        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
                        color: status.color
                    }
                ]}>
                    {status.text}
                </Text>
            </View>
        );
    };

    // Render individual item (for recent items)
    const renderItem = (item: T, isSelected: boolean, isLast: boolean, showDividerOverride?: boolean, forRecent = false) => {
        const itemId = config.getItemId(item);
        const title = config.getItemTitle(item);
        const subtitle = forRecent && config.getRecentItemSubtitle
            ? config.getRecentItemSubtitle(item)
            : config.getItemSubtitle?.(item);
        const icon = forRecent && config.getRecentItemIcon
            ? config.getRecentItemIcon(item)
            : config.getItemIcon(item);
        const status = config.getItemStatus?.(item, theme);

        return (
            <Item
                key={itemId}
                title={title}
                subtitle={subtitle}
                subtitleLines={0}
                leftElement={icon}
                rightElement={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: ITEM_SPACING_GAP }}>
                        {renderStatus(status)}
                        {isSelected && (
                            <Ionicons
                                name="checkmark-circle"
                                size={20}
                                color={theme.colors.button.primary.tint}
                            />
                        )}
                    </View>
                }
                onPress={() => handleSelectItem(item)}
                showChevron={false}
                selected={isSelected}
                showDivider={showDividerOverride !== undefined ? showDividerOverride : !isLast}
                style={[
                    styles.itemBackground,
                    config.compactItems ? styles.compactItemStyle : undefined,
                    isSelected ? styles.selectedItemStyle : undefined
                ]}
            />
        );
    };

    // "Show More" logic (matches Working Directory pattern)
    const itemsToShow = (inputText.trim() && isUserTyping.current) || showAllRecent
        ? filteredRecentItems
        : filteredRecentItems.slice(0, RECENT_ITEMS_DEFAULT_VISIBLE);

    return (
        <>
            {/* Search Input */}
            {showSearch && (
                <View style={styles.inputContainer}>
                    <View style={styles.inputWrapper}>
                        <View style={styles.inputInner}>
                            <View style={styles.inputField}>
                                <MultiTextInput
                                    value={inputText}
                                    onChangeText={handleInputChange}
                                    placeholder={config.searchPlaceholder}
                                    maxHeight={40}
                                    paddingTop={8}
                                    paddingBottom={8}
                                />
                            </View>
                            {inputText.trim() && (
                                <Pressable
                                    onPress={handleClear}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    style={({ pressed }) => ([
                                        styles.clearButton,
                                        { opacity: pressed ? 0.6 : 0.8 }
                                    ])}
                                >
                                    <Ionicons name="close" size={14} color={theme.colors.input.background} />
                                </Pressable>
                            )}
                        </View>
                    </View>
                    {showFavorites && onToggleFavorite && (
                        <Pressable
                            onPress={handleAddToFavorites}
                            disabled={!canAddToFavorites}
                            style={({ pressed }) => ([
                                styles.favoriteButton,
                                {
                                    backgroundColor: canAddToFavorites
                                        ? theme.colors.button.primary.background
                                        : theme.colors.divider,
                                    opacity: pressed ? 0.7 : 1,
                                }
                            ])}
                        >
                            <Ionicons
                                name="star"
                                size={20}
                                color={canAddToFavorites ? theme.colors.button.primary.tint : theme.colors.textSecondary}
                            />
                        </Pressable>
                    )}
                </View>
            )}

            {/* Recent Items Section */}
            {showRecent && filteredRecentItems.length > 0 && (
                <>
                    <Pressable
                        style={styles.sectionHeader}
                        onPress={toggleRecentSection}
                    >
                        <Text style={styles.sectionHeaderText}>{config.recentSectionTitle}</Text>
                        <Ionicons
                            name={showRecentSection ? "chevron-up" : "chevron-down"}
                            size={20}
                            color={theme.colors.text}
                        />
                    </Pressable>

                    {showRecentSection && (
                        <ItemGroup title="">
                            {itemsToShow.map((item, index, arr) => {
                                const itemId = config.getItemId(item);
                                const selectedId = selectedItem ? config.getItemId(selectedItem) : null;
                                const isSelected = itemId === selectedId;
                                const isLast = index === arr.length - 1;

                                // Override divider logic for "Show More" button
                                const showDivider = !isLast ||
                                    (!(inputText.trim() && isUserTyping.current) &&
                                     !showAllRecent &&
                                     filteredRecentItems.length > RECENT_ITEMS_DEFAULT_VISIBLE);

                                return renderItem(item, isSelected, isLast, showDivider, true);
                            })}

                            {/* Show More Button */}
                            {!(inputText.trim() && isUserTyping.current) &&
                             filteredRecentItems.length > RECENT_ITEMS_DEFAULT_VISIBLE && (
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
                </>
            )}

            {/* Favorites Section */}
            {showFavorites && filteredFavoriteItems.length > 0 && (
                <>
                    <Pressable
                        style={styles.sectionHeader}
                        onPress={toggleFavoritesSection}
                    >
                        <Text style={styles.sectionHeaderText}>{config.favoritesSectionTitle}</Text>
                        <Ionicons
                            name={showFavoritesSection ? "chevron-up" : "chevron-down"}
                            size={20}
                            color={theme.colors.text}
                        />
                    </Pressable>

                    {showFavoritesSection && (
                        <ItemGroup title="">
                            {filteredFavoriteItems.map((item, index) => {
                                const itemId = config.getItemId(item);
                                const selectedId = selectedItem ? config.getItemId(selectedItem) : null;
                                const isSelected = itemId === selectedId;
                                const isLast = index === filteredFavoriteItems.length - 1;

                                const title = config.getItemTitle(item);
                                const subtitle = config.getItemSubtitle?.(item);
                                const icon = config.getFavoriteItemIcon?.(item) || config.getItemIcon(item);
                                const status = config.getItemStatus?.(item, theme);
                                const canRemove = config.canRemoveFavorite?.(item) ?? true;

                                return (
                                    <Item
                                        key={itemId}
                                        title={title}
                                        subtitle={subtitle}
                                        subtitleLines={0}
                                        leftElement={icon}
                                        rightElement={
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: ITEM_SPACING_GAP }}>
                                                {renderStatus(status)}
                                                {isSelected && (
                                                    <Ionicons
                                                        name="checkmark-circle"
                                                        size={20}
                                                        color={theme.colors.button.primary.tint}
                                                    />
                                                )}
                                                {onToggleFavorite && canRemove && (
                                                    <Pressable
                                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                        onPress={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveFavorite(item);
                                                        }}
                                                    >
                                                        <Ionicons name="trash-outline" size={20} color="#FF6B6B" />
                                                    </Pressable>
                                                )}
                                            </View>
                                        }
                                        onPress={() => handleSelectItem(item)}
                                        showChevron={false}
                                        selected={isSelected}
                                        showDivider={!isLast}
                                        style={[
                                            styles.itemBackground,
                                            config.compactItems ? styles.compactItemStyle : undefined,
                                            isSelected ? styles.selectedItemStyle : undefined
                                        ]}
                                    />
                                );
                            })}
                        </ItemGroup>
                    )}
                </>
            )}

            {/* All Items Section - always shown when items provided */}
            {items.length > 0 && (
                <>
                    <Pressable
                        style={styles.sectionHeader}
                        onPress={toggleAllItemsSection}
                    >
                        <Text style={styles.sectionHeaderText}>
                            {config.recentSectionTitle.replace('Recent ', 'All ')}
                        </Text>
                        <Ionicons
                            name={showAllItemsSection ? "chevron-up" : "chevron-down"}
                            size={20}
                            color={theme.colors.text}
                        />
                    </Pressable>

                    {showAllItemsSection && (
                        <ItemGroup title="">
                            {items.map((item, index) => {
                                const itemId = config.getItemId(item);
                                const selectedId = selectedItem ? config.getItemId(selectedItem) : null;
                                const isSelected = itemId === selectedId;
                                const isLast = index === items.length - 1;

                                return renderItem(item, isSelected, isLast, !isLast, false);
                            })}
                        </ItemGroup>
                    )}
                </>
            )}
        </>
    );
}
