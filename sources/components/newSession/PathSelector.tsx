import React, { useMemo, useRef, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { SearchHeader } from '@/components/SearchHeader';
import { MultiTextInput, MultiTextInputHandle } from '@/components/MultiTextInput';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';

export interface PathSelectorProps {
    machineHomeDir: string;
    selectedPath: string;
    onChangeSelectedPath: (path: string) => void;
    recentPaths: string[];
    usePickerSearch: boolean;
    searchVariant?: 'header' | 'group' | 'none';
    searchQuery?: string;
    onChangeSearchQuery?: (text: string) => void;
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (dirs: string[]) => void;
}

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
}));

const ITEM_RIGHT_GAP = 16;

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
}: PathSelectorProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const inputRef = useRef<MultiTextInputHandle>(null);

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = useState('');
    const searchQuery = controlledSearchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = onChangeSearchQueryProp ?? setUncontrolledSearchQuery;

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

    const setPathAndFocus = React.useCallback((path: string) => {
        onChangeSelectedPath(path);
        setTimeout(() => inputRef.current?.focus(), 50);
    }, [onChangeSelectedPath]);

    const renderRightElement = React.useCallback((absolutePath: string, isSelected: boolean, isFavorite: boolean) => {
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: ITEM_RIGHT_GAP }}>
                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                        name="checkmark-circle"
                        size={24}
                        color={theme.colors.button.primary.background}
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
                        size={20}
                        color={isFavorite ? theme.colors.button.primary.background : theme.colors.textSecondary}
                    />
                </Pressable>
            </View>
        );
    }, [theme.colors.button.primary.background, theme.colors.textSecondary, toggleFavorite]);

    return (
        <>
            {usePickerSearch && searchVariant === 'header' && (
                <SearchHeader
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Search paths..."
                />
            )}

            <ItemGroup title="Enter Path">
                <View style={styles.pathInputContainer}>
                    <View style={[styles.pathInput, { paddingVertical: 8 }]}>
                        <MultiTextInput
                            ref={inputRef}
                            value={selectedPath}
                            onChangeText={onChangeSelectedPath}
                            placeholder="Enter path (e.g. /home/user/projects)"
                            maxHeight={76}
                            paddingTop={8}
                            paddingBottom={8}
                        />
                    </View>
                </View>
            </ItemGroup>

            {usePickerSearch && searchVariant === 'group' && filteredRecentPaths.length > 0 && (
                <ItemGroup title="Recent Paths">
                    <SearchHeader
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder="Search paths..."
                    />
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
                                pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                rightElement={renderRightElement(path, isSelected, isFavorite)}
                                showDivider={!isLast}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {filteredFavoritePaths.length > 0 && (
                <ItemGroup title="Favorite Paths">
                    {filteredFavoritePaths.map((path, index) => {
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
                                pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                rightElement={renderRightElement(path, isSelected, true)}
                                showDivider={!isLast}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {filteredRecentPaths.length > 0 && searchVariant !== 'group' && (
                <ItemGroup title="Recent Paths">
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
                                pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                rightElement={renderRightElement(path, isSelected, isFavorite)}
                                showDivider={!isLast}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {usePickerSearch && searchVariant === 'group' && filteredRecentPaths.length === 0 && filteredSuggestedPaths.length > 0 && (
                <ItemGroup title="Suggested Paths">
                    <SearchHeader
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder="Search paths..."
                    />
                    {filteredSuggestedPaths.map((path, index) => {
                        const isSelected = selectedPath.trim() === path;
                        const isLast = index === filteredSuggestedPaths.length - 1;
                        const isFavorite = favoritePaths.includes(path);
                        return (
                            <Item
                                key={path}
                                title={path}
                                leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
                                onPress={() => setPathAndFocus(path)}
                                selected={isSelected}
                                showChevron={false}
                                pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                rightElement={renderRightElement(path, isSelected, isFavorite)}
                                showDivider={!isLast}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {filteredRecentPaths.length === 0 && filteredSuggestedPaths.length > 0 && searchVariant !== 'group' && (
                <ItemGroup title="Suggested Paths">
                    {filteredSuggestedPaths.map((path, index) => {
                        const isSelected = selectedPath.trim() === path;
                        const isLast = index === filteredSuggestedPaths.length - 1;
                        const isFavorite = favoritePaths.includes(path);
                        return (
                            <Item
                                key={path}
                                title={path}
                                leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
                                onPress={() => setPathAndFocus(path)}
                                selected={isSelected}
                                showChevron={false}
                                pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                rightElement={renderRightElement(path, isSelected, isFavorite)}
                                showDivider={!isLast}
                            />
                        );
                    })}
                </ItemGroup>
            )}
        </>
    );
}
