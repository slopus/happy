import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, TextInput, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { Typography } from '@/constants/Typography';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { t } from '@/text';

type PathSelectorBaseProps = {
    machineHomeDir: string;
    selectedPath: string;
    onChangeSelectedPath: (path: string) => void;
    onSubmitSelectedPath?: (path: string) => void;
    submitBehavior?: 'showRow' | 'confirm';
    recentPaths: string[];
    usePickerSearch: boolean;
    searchVariant?: 'header' | 'group' | 'none';
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (dirs: string[]) => void;
    /**
     * When true, clicking a path row will focus the input (and try to place cursor at the end).
     * Wizard UX generally wants this OFF; the dedicated picker screen wants this ON.
     */
    focusInputOnSelect?: boolean;
};

type PathSelectorControlledSearchProps = {
    searchQuery: string;
    onChangeSearchQuery: (text: string) => void;
};

type PathSelectorUncontrolledSearchProps = {
    searchQuery?: undefined;
    onChangeSearchQuery?: undefined;
};

export type PathSelectorProps =
    & PathSelectorBaseProps
    & (PathSelectorControlledSearchProps | PathSelectorUncontrolledSearchProps);

const ITEM_RIGHT_GAP = 16;

const stylesheet = StyleSheet.create((theme) => ({
    pathInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    pathInput: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        minHeight: 36,
        position: 'relative',
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
    searchHeaderContainer: {
        backgroundColor: 'transparent',
        borderBottomWidth: 0,
    },
    rightElementRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: ITEM_RIGHT_GAP,
    },
    iconSlot: {
        width: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export function PathSelector({
    machineHomeDir,
    selectedPath,
    onChangeSelectedPath,
    recentPaths,
    usePickerSearch,
    searchVariant = 'header',
    searchQuery: controlledSearchQuery,
    onChangeSearchQuery: onChangeSearchQueryProp,
    favoriteDirectories,
    onChangeFavoriteDirectories,
    onSubmitSelectedPath,
    submitBehavior = 'showRow',
    focusInputOnSelect = true,
}: PathSelectorProps) {
    const { theme, rt } = useUnistyles();
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const styles = stylesheet;
    const inputRef = useRef<TextInput>(null);
    const searchInputRef = useRef<TextInput>(null);
    const searchWasFocusedRef = useRef(false);

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = useState('');
    const isSearchQueryControlled = controlledSearchQuery !== undefined && onChangeSearchQueryProp !== undefined;
    const searchQuery = isSearchQueryControlled ? controlledSearchQuery : uncontrolledSearchQuery;
    const setSearchQuery = isSearchQueryControlled ? onChangeSearchQueryProp : setUncontrolledSearchQuery;
    const [submittedCustomPath, setSubmittedCustomPath] = useState<string | null>(null);

    const suggestedPaths = useMemo(() => {
        const homeDir = machineHomeDir || '/home';
        return [
            homeDir,
            `${homeDir}/projects`,
            `${homeDir}/Documents`,
            `${homeDir}/Desktop`,
        ];
    }, [machineHomeDir]);

    const favoritePaths = useMemo(() => {
        const homeDir = machineHomeDir || '/home';
        const paths = favoriteDirectories.map((fav) => resolveAbsolutePath(fav, homeDir));
        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const p of paths) {
            if (!p) continue;
            if (seen.has(p)) continue;
            seen.add(p);
            ordered.push(p);
        }
        return ordered;
    }, [favoriteDirectories, machineHomeDir]);

    const filteredFavoritePaths = useMemo(() => {
        if (!usePickerSearch || !searchQuery.trim()) return favoritePaths;
        const query = searchQuery.toLowerCase();
        return favoritePaths.filter((path) => path.toLowerCase().includes(query));
    }, [favoritePaths, searchQuery, usePickerSearch]);

    const filteredRecentPaths = useMemo(() => {
        const base = recentPaths.filter((p) => !favoritePaths.includes(p));
        if (!usePickerSearch || !searchQuery.trim()) return base;
        const query = searchQuery.toLowerCase();
        return base.filter((path) => path.toLowerCase().includes(query));
    }, [favoritePaths, recentPaths, searchQuery, usePickerSearch]);

    const filteredSuggestedPaths = useMemo(() => {
        const base = suggestedPaths.filter((p) => !favoritePaths.includes(p));
        if (!usePickerSearch || !searchQuery.trim()) return base;
        const query = searchQuery.toLowerCase();
        return base.filter((path) => path.toLowerCase().includes(query));
    }, [favoritePaths, searchQuery, suggestedPaths, usePickerSearch]);

    const baseRecentPaths = useMemo(() => {
        return recentPaths.filter((p) => !favoritePaths.includes(p));
    }, [favoritePaths, recentPaths]);

    const baseSuggestedPaths = useMemo(() => {
        return suggestedPaths.filter((p) => !favoritePaths.includes(p));
    }, [favoritePaths, suggestedPaths]);

    const effectiveGroupSearchPlacement = useMemo(() => {
        if (!usePickerSearch || searchVariant !== 'group') return null as null | 'favorites' | 'recent' | 'suggested' | 'fallback';
        const preferred: 'suggested' | 'recent' | 'favorites' | 'fallback' =
            baseSuggestedPaths.length > 0 ? 'suggested'
                : baseRecentPaths.length > 0 ? 'recent'
                    : favoritePaths.length > 0 ? 'favorites'
                        : 'fallback';

        if (preferred === 'suggested') {
            if (filteredSuggestedPaths.length > 0) return 'suggested';
            if (filteredFavoritePaths.length > 0) return 'favorites';
            if (filteredRecentPaths.length > 0) return 'recent';
            return 'suggested';
        }

        if (preferred === 'recent') {
            if (filteredRecentPaths.length > 0) return 'recent';
            if (filteredFavoritePaths.length > 0) return 'favorites';
            if (filteredSuggestedPaths.length > 0) return 'suggested';
            return 'recent';
        }

        if (preferred === 'favorites') {
            if (filteredFavoritePaths.length > 0) return 'favorites';
            if (filteredRecentPaths.length > 0) return 'recent';
            if (filteredSuggestedPaths.length > 0) return 'suggested';
            return 'favorites';
        }

        return 'fallback';
    }, [
        baseRecentPaths.length,
        baseSuggestedPaths.length,
        favoritePaths.length,
        filteredFavoritePaths.length,
        filteredRecentPaths.length,
        filteredSuggestedPaths.length,
        searchVariant,
        usePickerSearch,
    ]);

    useEffect(() => {
        if (!usePickerSearch || searchVariant !== 'group') return;
        if (!searchWasFocusedRef.current) return;

        const id = setTimeout(() => {
            // Keep the search box usable while it moves between groups by restoring focus.
            // (The underlying TextInput unmounts/remounts as placement changes.)
            try {
                searchInputRef.current?.focus?.();
            } catch { }
        }, 0);
        return () => clearTimeout(id);
    }, [effectiveGroupSearchPlacement, searchVariant, usePickerSearch]);

    const showNoMatchesRow = usePickerSearch && searchQuery.trim().length > 0;
    const shouldRenderFavoritesGroup = filteredFavoritePaths.length > 0 || effectiveGroupSearchPlacement === 'favorites';
    const shouldRenderRecentGroup = filteredRecentPaths.length > 0 || effectiveGroupSearchPlacement === 'recent';
    const shouldRenderSuggestedGroup = filteredSuggestedPaths.length > 0 || effectiveGroupSearchPlacement === 'suggested';
    const shouldRenderFallbackGroup = effectiveGroupSearchPlacement === 'fallback';

    const toggleFavorite = React.useCallback((absolutePath: string) => {
        const homeDir = machineHomeDir || '/home';

        const relativePath = formatPathRelativeToHome(absolutePath, homeDir);
        const resolved = resolveAbsolutePath(relativePath, homeDir);
        const isInFavorites = favoriteDirectories.some((fav) => resolveAbsolutePath(fav, homeDir) === resolved);

        onChangeFavoriteDirectories(isInFavorites
            ? favoriteDirectories.filter((fav) => resolveAbsolutePath(fav, homeDir) !== resolved)
            : [...favoriteDirectories, relativePath]
        );
    }, [favoriteDirectories, machineHomeDir, onChangeFavoriteDirectories]);

    const handleChangeSelectedPath = React.useCallback((text: string) => {
        onChangeSelectedPath(text);
        if (submittedCustomPath && text.trim() !== submittedCustomPath) {
            setSubmittedCustomPath(null);
        }
    }, [onChangeSelectedPath, submittedCustomPath]);

    const focusInputAtEnd = React.useCallback((value: string) => {
        if (!focusInputOnSelect) return;
        // Small delay so RN has applied the value before selection.
        setTimeout(() => {
            const input = inputRef.current;
            input?.focus?.();
            try {
                input?.setNativeProps?.({ selection: { start: value.length, end: value.length } });
            } catch { }
        }, 50);
    }, [focusInputOnSelect]);

    const setPathAndFocus = React.useCallback((path: string) => {
        onChangeSelectedPath(path);
        setSubmittedCustomPath(null);
        focusInputAtEnd(path);
    }, [focusInputAtEnd, onChangeSelectedPath]);

    const handleSubmitPath = React.useCallback(() => {
        const trimmed = selectedPath.trim();
        if (!trimmed) return;

        if (trimmed !== selectedPath) {
            onChangeSelectedPath(trimmed);
        }

        onSubmitSelectedPath?.(trimmed);
        if (submitBehavior !== 'confirm') {
            setSubmittedCustomPath(trimmed);
        }
    }, [onChangeSelectedPath, onSubmitSelectedPath, selectedPath, submitBehavior]);

    const renderRightElement = React.useCallback((absolutePath: string, isSelected: boolean, isFavorite: boolean) => {
        return (
            <View style={styles.rightElementRow}>
                <View style={styles.iconSlot}>
                    <Ionicons
                        name="checkmark-circle"
                        size={24}
                        color={selectedIndicatorColor}
                        style={{ opacity: isSelected ? 1 : 0 }}
                    />
                </View>
                <Pressable
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPress={(e) => {
                        e.stopPropagation();
                        toggleFavorite(absolutePath);
                    }}
                >
                    <Ionicons
                        name={isFavorite ? 'star' : 'star-outline'}
                        size={24}
                        color={isFavorite ? selectedIndicatorColor : theme.colors.textSecondary}
                    />
                </Pressable>
            </View>
        );
    }, [selectedIndicatorColor, theme.colors.textSecondary, toggleFavorite]);

    const renderCustomRightElement = React.useCallback((absolutePath: string) => {
        const isFavorite = favoritePaths.includes(absolutePath);
        return (
            <View style={styles.rightElementRow}>
                <View style={styles.iconSlot}>
                    <Ionicons
                        name="checkmark-circle"
                        size={24}
                        color={selectedIndicatorColor}
                    />
                </View>
                <Pressable
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPress={(e) => {
                        e.stopPropagation();
                        toggleFavorite(absolutePath);
                    }}
                >
                    <Ionicons
                        name={isFavorite ? 'star' : 'star-outline'}
                        size={24}
                        color={isFavorite ? selectedIndicatorColor : theme.colors.textSecondary}
                    />
                </Pressable>
                <Pressable
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    onPress={(e) => {
                        e.stopPropagation();
                        setSubmittedCustomPath(null);
                        onChangeSelectedPath('');
                        setTimeout(() => inputRef.current?.focus(), 50);
                    }}
                >
                    <Ionicons
                        name="close-circle"
                        size={24}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            </View>
        );
    }, [favoritePaths, onChangeSelectedPath, selectedIndicatorColor, theme.colors.textSecondary, toggleFavorite]);

    const showSubmittedCustomPathRow = useMemo(() => {
        if (!submittedCustomPath) return null;
        const trimmed = selectedPath.trim();
        if (!trimmed) return null;
        if (trimmed !== submittedCustomPath) return null;

        const visiblePaths = new Set<string>([
            ...filteredFavoritePaths,
            ...filteredRecentPaths,
            ...filteredSuggestedPaths,
        ]);
        if (visiblePaths.has(trimmed)) return null;

        return trimmed;
    }, [filteredFavoritePaths, filteredRecentPaths, filteredSuggestedPaths, selectedPath, submittedCustomPath]);

    return (
        <>
            {usePickerSearch && searchVariant === 'header' && (
                <SearchHeader
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder={t('newSession.searchPathsPlaceholder')}
                />
            )}

            <ItemGroup title={t('newSession.pathPicker.enterPathTitle')}>
                <View style={styles.pathInputContainer}>
                    <View style={[styles.pathInput, { paddingVertical: 8 }]}>
                        <TextInput
                            ref={inputRef}
                            value={selectedPath}
                            onChangeText={handleChangeSelectedPath}
                            placeholder={t('newSession.pathPicker.enterPathPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            style={[
                                {
                                    color: theme.colors.input.text,
                                    paddingTop: 8,
                                    paddingBottom: 8,
                                },
                                Typography.default(),
                                Platform.OS === 'web'
                                    ? ({
                                        outlineStyle: 'none',
                                        outlineWidth: 0,
                                        boxShadow: 'none',
                                    } as any)
                                    : undefined,
                            ]}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="off"
                            textContentType="none"
                            importantForAutofill="no"
                            returnKeyType="done"
                            blurOnSubmit={true}
                            multiline={false}
                            onSubmitEditing={handleSubmitPath}
                        />
                    </View>
                </View>
            </ItemGroup>

            {showSubmittedCustomPathRow && (
                <ItemGroup title={t('newSession.pathPicker.customPathTitle')}>
                    <Item
                        key={showSubmittedCustomPathRow}
                        title={showSubmittedCustomPathRow}
                        leftElement={<Ionicons name="folder-outline" size={24} color={theme.colors.textSecondary} />}
                        onPress={() => focusInputAtEnd(showSubmittedCustomPathRow)}
                        selected={true}
                        showChevron={false}
                        rightElement={renderCustomRightElement(showSubmittedCustomPathRow)}
                        showDivider={false}
                    />
                </ItemGroup>
            )}

            {usePickerSearch && searchVariant === 'group' && shouldRenderRecentGroup && (
                <ItemGroup title={t('newSession.pathPicker.recentTitle')}>
                    {effectiveGroupSearchPlacement === 'recent' && (
                        <SearchHeader
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            placeholder={t('newSession.searchPathsPlaceholder')}
                            inputRef={searchInputRef}
                            onFocus={() => { searchWasFocusedRef.current = true; }}
                            onBlur={() => { searchWasFocusedRef.current = false; }}
                            containerStyle={styles.searchHeaderContainer}
                        />
                    )}
                    {filteredRecentPaths.length === 0
                        ? (
                            <Item
                                title={showNoMatchesRow ? t('common.noMatches') : t('newSession.pathPicker.emptyRecent')}
                                showChevron={false}
                                showDivider={false}
                                disabled={true}
                            />
                        )
                        : filteredRecentPaths.map((path, index) => {
                            const isSelected = selectedPath.trim() === path;
                            const isLast = index === filteredRecentPaths.length - 1;
                            const isFavorite = favoritePaths.includes(path);
                            return (
	                                <Item
	                                    key={path}
	                                    title={path}
	                                    leftElement={<Ionicons name="folder-outline" size={24} color={theme.colors.textSecondary} />}
	                                    onPress={() => setPathAndFocus(path)}
                                    selected={isSelected}
                                    showChevron={false}
                                    rightElement={renderRightElement(path, isSelected, isFavorite)}
                                    showDivider={!isLast}
                                />
                            );
                        })}
                </ItemGroup>
            )}

            {shouldRenderFavoritesGroup && (
                <ItemGroup title={t('newSession.pathPicker.favoritesTitle')}>
                    {usePickerSearch && searchVariant === 'group' && effectiveGroupSearchPlacement === 'favorites' && (
                        <SearchHeader
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            placeholder={t('newSession.searchPathsPlaceholder')}
                            inputRef={searchInputRef}
                            onFocus={() => { searchWasFocusedRef.current = true; }}
                            onBlur={() => { searchWasFocusedRef.current = false; }}
                            containerStyle={styles.searchHeaderContainer}
                        />
                    )}
                    {filteredFavoritePaths.length === 0
                        ? (
                            <Item
                                title={showNoMatchesRow ? t('common.noMatches') : t('newSession.pathPicker.emptyFavorites')}
                                showChevron={false}
                                showDivider={false}
                                disabled={true}
                            />
                        )
                        : filteredFavoritePaths.map((path, index) => {
                            const isSelected = selectedPath.trim() === path;
                            const isLast = index === filteredFavoritePaths.length - 1;
                            return (
	                                <Item
	                                    key={path}
	                                    title={path}
	                                    leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
	                                    onPress={() => setPathAndFocus(path)}
	                                    selected={isSelected}
	                                    showChevron={false}
	                                    rightElement={renderRightElement(path, isSelected, true)}
	                                    showDivider={!isLast}
	                                />
                            );
                        })}
                </ItemGroup>
            )}

            {filteredRecentPaths.length > 0 && searchVariant !== 'group' && (
                <ItemGroup title={t('newSession.pathPicker.recentTitle')}>
                    {filteredRecentPaths.map((path, index) => {
                        const isSelected = selectedPath.trim() === path;
                        const isLast = index === filteredRecentPaths.length - 1;
                        const isFavorite = favoritePaths.includes(path);
                        return (
	                            <Item
	                                key={path}
	                                title={path}
	                                leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
	                                onPress={() => setPathAndFocus(path)}
	                                selected={isSelected}
	                                showChevron={false}
	                                rightElement={renderRightElement(path, isSelected, isFavorite)}
	                                showDivider={!isLast}
	                            />
                        );
                    })}
                </ItemGroup>
            )}

            {usePickerSearch && searchVariant === 'group' && shouldRenderSuggestedGroup && (
                <ItemGroup title={t('newSession.pathPicker.suggestedTitle')}>
                    {effectiveGroupSearchPlacement === 'suggested' && (
                        <SearchHeader
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            placeholder={t('newSession.searchPathsPlaceholder')}
                            inputRef={searchInputRef}
                            onFocus={() => { searchWasFocusedRef.current = true; }}
                            onBlur={() => { searchWasFocusedRef.current = false; }}
                            containerStyle={styles.searchHeaderContainer}
                        />
                    )}
                    {filteredSuggestedPaths.length === 0
                        ? (
                            <Item
                                title={showNoMatchesRow ? t('common.noMatches') : t('newSession.pathPicker.emptySuggested')}
                                showChevron={false}
                                showDivider={false}
                                disabled={true}
                            />
                        )
                        : filteredSuggestedPaths.map((path, index) => {
                            const isSelected = selectedPath.trim() === path;
                            const isLast = index === filteredSuggestedPaths.length - 1;
                            const isFavorite = favoritePaths.includes(path);
                            return (
	                                <Item
	                                    key={path}
	                                    title={path}
	                                    leftElement={<Ionicons name="folder-outline" size={24} color={theme.colors.textSecondary} />}
	                                    onPress={() => setPathAndFocus(path)}
	                                    selected={isSelected}
	                                    showChevron={false}
	                                    rightElement={renderRightElement(path, isSelected, isFavorite)}
	                                    showDivider={!isLast}
	                                />
                            );
                        })}
                </ItemGroup>
            )}

            {filteredRecentPaths.length === 0 && filteredSuggestedPaths.length > 0 && searchVariant !== 'group' && (
                <ItemGroup title={t('newSession.pathPicker.suggestedTitle')}>
                    {filteredSuggestedPaths.map((path, index) => {
                        const isSelected = selectedPath.trim() === path;
                        const isLast = index === filteredSuggestedPaths.length - 1;
                        const isFavorite = favoritePaths.includes(path);
                        return (
	                                <Item
	                                    key={path}
	                                    title={path}
	                                    leftElement={<Ionicons name="folder-outline" size={24} color={theme.colors.textSecondary} />}
	                                    onPress={() => setPathAndFocus(path)}
	                                    selected={isSelected}
	                                    showChevron={false}
	                                    rightElement={renderRightElement(path, isSelected, isFavorite)}
	                                showDivider={!isLast}
	                            />
                        );
                    })}
                </ItemGroup>
            )}

            {usePickerSearch && searchVariant === 'group' && shouldRenderFallbackGroup && (
                <ItemGroup title={t('newSession.pathPicker.allTitle')}>
                    <SearchHeader
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder={t('newSession.searchPathsPlaceholder')}
                        inputRef={searchInputRef}
                        onFocus={() => { searchWasFocusedRef.current = true; }}
                        onBlur={() => { searchWasFocusedRef.current = false; }}
                        containerStyle={styles.searchHeaderContainer}
                    />
                    <Item
                        title={showNoMatchesRow ? t('common.noMatches') : t('newSession.pathPicker.emptyAll')}
                        showChevron={false}
                        showDivider={false}
                        disabled={true}
                    />
                </ItemGroup>
            )}
        </>
    );
}
