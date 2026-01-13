import React, { useState, useMemo, useRef } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { CommonActions, useNavigation } from '@react-navigation/native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { layout } from '@/components/layout';
import { MultiTextInput, MultiTextInputHandle } from '@/components/MultiTextInput';
import { SearchHeader } from '@/components/SearchHeader';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';

const stylesheet = StyleSheet.create((theme) => ({
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    contentWrapper: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
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

export default function PathPickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ machineId?: string; selectedPath?: string }>();
    const machines = useAllMachines();
    const sessions = useSessions();
    const recentMachinePaths = useSetting('recentMachinePaths');
    const usePickerSearch = useSetting('usePickerSearch');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const inputRef = useRef<MultiTextInputHandle>(null);

    const [customPath, setCustomPath] = useState(params.selectedPath || '');
    const [searchQuery, setSearchQuery] = useState('');

    // Get the selected machine
    const machine = useMemo(() => {
        return machines.find(m => m.id === params.machineId);
    }, [machines, params.machineId]);

    // Get recent paths for this machine - prioritize from settings, then fall back to sessions
    const recentPaths = useMemo(() => {
        if (!params.machineId) return [];

        const paths: string[] = [];
        const pathSet = new Set<string>();

        // First, add paths from recentMachinePaths (these are the most recent)
        recentMachinePaths.forEach(entry => {
            if (entry.machineId === params.machineId && !pathSet.has(entry.path)) {
                paths.push(entry.path);
                pathSet.add(entry.path);
            }
        });

        // Then add paths from sessions if we need more
        if (sessions) {
            const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];

            sessions.forEach(item => {
                if (typeof item === 'string') return; // Skip section headers

                const session = item as any;
                if (session.metadata?.machineId === params.machineId && session.metadata?.path) {
                    const path = session.metadata.path;
                    if (!pathSet.has(path)) {
                        pathSet.add(path);
                        pathsWithTimestamps.push({
                            path,
                            timestamp: session.updatedAt || session.createdAt
                        });
                    }
                }
            });

            // Sort session paths by most recent first and add them
            pathsWithTimestamps
                .sort((a, b) => b.timestamp - a.timestamp)
                .forEach(item => paths.push(item.path));
        }

        return paths;
    }, [sessions, params.machineId, recentMachinePaths]);


    const handleSelectPath = React.useCallback(() => {
        const pathToUse = customPath.trim() || machine?.metadata?.homeDir || '/home';
        // Pass path back via navigation params (main's pattern, received by new/index.tsx)
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ path: pathToUse }),
                source: previousRoute.key,
            } as never);
        }
        router.back();
    }, [customPath, router, machine, navigation]);

    const suggestedPaths = useMemo(() => {
        if (!machine) return [];
        const homeDir = machine.metadata?.homeDir || '/home';
        return [
            homeDir,
            `${homeDir}/projects`,
            `${homeDir}/Documents`,
            `${homeDir}/Desktop`,
        ];
    }, [machine]);

    const favoritePaths = useMemo(() => {
        if (!machine) return [];
        const homeDir = machine.metadata?.homeDir || '/home';
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
    }, [favoriteDirectories, machine]);

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

    const filteredFavoritePaths = useMemo(() => {
        if (!usePickerSearch || !searchQuery.trim()) return favoritePaths;
        const query = searchQuery.toLowerCase();
        return favoritePaths.filter((path) => path.toLowerCase().includes(query));
    }, [favoritePaths, searchQuery, usePickerSearch]);

    const toggleFavorite = React.useCallback((absolutePath: string) => {
        if (!machine) return;
        const homeDir = machine.metadata?.homeDir || '/home';

        const relativePath = formatPathRelativeToHome(absolutePath, homeDir);
        const resolved = resolveAbsolutePath(relativePath, homeDir);
        const isInFavorites = favoriteDirectories.some((fav) => resolveAbsolutePath(fav, homeDir) === resolved);

        setFavoriteDirectories(isInFavorites
            ? favoriteDirectories.filter((fav) => resolveAbsolutePath(fav, homeDir) !== resolved)
            : [...favoriteDirectories, relativePath]
        );
    }, [favoriteDirectories, machine, setFavoriteDirectories]);

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: 'Select Path',
                        headerBackTitle: t('common.back'),
                        headerRight: () => (
                            <Pressable
                                onPress={handleSelectPath}
                                disabled={!customPath.trim()}
                                style={({ pressed }) => ({
                                    marginRight: 16,
                                    opacity: pressed ? 0.7 : 1,
                                    padding: 4,
                                })}
                            >
                                <Ionicons
                                    name="checkmark"
                                    size={24}
                                    color={theme.colors.header.tint}
                                />
                            </Pressable>
                        )
                    }}
                />
                <ItemList>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>No machine selected</Text>
                    </View>
                </ItemList>
            </>
        );
    }

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: 'Select Path',
                    headerBackTitle: t('common.back'),
                    headerRight: () => (
                        <Pressable
                            onPress={handleSelectPath}
                            disabled={!customPath.trim()}
                            style={({ pressed }) => ({
                                opacity: pressed ? 0.7 : 1,
                                padding: 4,
                            })}
                        >
                            <Ionicons
                                name="checkmark"
                                size={24}
                                color={theme.colors.header.tint}
                            />
                        </Pressable>
                    )
                }}
            />
            <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
                {usePickerSearch && (
                    <SearchHeader
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder="Search paths..."
                    />
                )}
                <View style={styles.contentWrapper}>
                    <ItemGroup title="Enter Path">
                        <View style={styles.pathInputContainer}>
                            <View style={[styles.pathInput, { paddingVertical: 8 }]}>
                                <MultiTextInput
                                    ref={inputRef}
                                    value={customPath}
                                    onChangeText={setCustomPath}
                                    placeholder="Enter path (e.g. /home/user/projects)"
                                    maxHeight={76}
                                    paddingTop={8}
                                    paddingBottom={8}
                                />
                            </View>
                        </View>
                    </ItemGroup>

                    {filteredFavoritePaths.length > 0 && (
                        <ItemGroup title="Favorite Paths">
                            {filteredFavoritePaths.map((path, index) => {
                                const isSelected = customPath.trim() === path;
                                const isLast = index === filteredFavoritePaths.length - 1;
                                return (
                                    <Item
                                        key={path}
                                        title={path}
                                        leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
                                        onPress={() => {
                                            setCustomPath(path);
                                            setTimeout(() => inputRef.current?.focus(), 50);
                                        }}
                                        selected={isSelected}
                                        showChevron={false}
                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                        rightElement={(
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    toggleFavorite(path);
                                                }}
                                            >
                                                <Ionicons
                                                    name="star"
                                                    size={20}
                                                    color={theme.colors.button.primary.background}
                                                />
                                            </Pressable>
                                        )}
                                        showDivider={!isLast}
                                    />
                                );
                            })}
                        </ItemGroup>
                    )}

                    {filteredRecentPaths.length > 0 && (
                        <ItemGroup title="Recent Paths">
                            {filteredRecentPaths.map((path, index) => {
                                const isSelected = customPath.trim() === path;
                                const isLast = index === filteredRecentPaths.length - 1;
                                const isFavorite = favoritePaths.includes(path);
                                return (
                                    <Item
                                        key={path}
                                        title={path}
                                        leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
                                        onPress={() => {
                                            setCustomPath(path);
                                            setTimeout(() => inputRef.current?.focus(), 50);
                                        }}
                                        selected={isSelected}
                                        showChevron={false}
                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                        rightElement={(
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    toggleFavorite(path);
                                                }}
                                            >
                                                <Ionicons
                                                    name={isFavorite ? 'star' : 'star-outline'}
                                                    size={20}
                                                    color={isFavorite ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                                />
                                            </Pressable>
                                        )}
                                        showDivider={!isLast}
                                    />
                                );
                            })}
                        </ItemGroup>
                    )}

                    {filteredRecentPaths.length === 0 && filteredSuggestedPaths.length > 0 && (
                        <ItemGroup title="Suggested Paths">
                            {filteredSuggestedPaths.map((path, index) => {
                                const isSelected = customPath.trim() === path;
                                const isLast = index === filteredSuggestedPaths.length - 1;
                                const isFavorite = favoritePaths.includes(path);
                                return (
                                    <Item
                                        key={path}
                                        title={path}
                                        leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
                                        onPress={() => {
                                            setCustomPath(path);
                                            setTimeout(() => inputRef.current?.focus(), 50);
                                        }}
                                        selected={isSelected}
                                        showChevron={false}
                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                        rightElement={(
                                            <Pressable
                                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                                onPress={(e) => {
                                                    e.stopPropagation();
                                                    toggleFavorite(path);
                                                }}
                                            >
                                                <Ionicons
                                                    name={isFavorite ? 'star' : 'star-outline'}
                                                    size={20}
                                                    color={isFavorite ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                                />
                                            </Pressable>
                                        )}
                                        showDivider={!isLast}
                                    />
                                );
                            })}
                        </ItemGroup>
                    )}
                </View>
            </ItemList>
        </>
    );
}
