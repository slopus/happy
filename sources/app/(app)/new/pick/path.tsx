import React, { useState, useMemo } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { layout } from '@/components/layout';
import { PathSelector } from '@/components/newSession/PathSelector';
import { SearchHeader } from '@/components/SearchHeader';

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

export default React.memo(function PathPickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ machineId?: string; selectedPath?: string }>();
    const machines = useAllMachines();
    const sessions = useSessions();
    const recentMachinePaths = useSetting('recentMachinePaths');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [favoriteDirectories, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');

    const [customPath, setCustomPath] = useState(params.selectedPath || '');
    const [pathSearchQuery, setPathSearchQuery] = useState('');

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


    const handleSelectPath = React.useCallback((pathOverride?: string) => {
        const rawPath = typeof pathOverride === 'string' ? pathOverride : customPath;
        const pathToUse = rawPath.trim() || machine?.metadata?.homeDir || '/home';
        // Pass path back via navigation params (main's pattern, received by new/index.tsx)
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { path: pathToUse } },
                source: previousRoute.key,
            } as never);
        }
        router.back();
    }, [customPath, router, machine, navigation]);

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: t('newSession.selectPathTitle'),
                        headerBackTitle: t('common.back'),
                        headerRight: () => (
                            <Pressable
                                onPress={() => handleSelectPath()}
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
                        <Text style={styles.emptyText}>{t('newSession.noMachineSelected')}</Text>
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
                    headerTitle: t('newSession.selectPathTitle'),
                    headerBackTitle: t('common.back'),
                        headerRight: () => (
                            <Pressable
                                onPress={() => handleSelectPath()}
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
                {usePathPickerSearch && (
                    <SearchHeader
                        value={pathSearchQuery}
                        onChangeText={setPathSearchQuery}
                        placeholder={t('newSession.searchPathsPlaceholder')}
                    />
                )}
                <View style={styles.contentWrapper}>
                    <PathSelector
                        machineHomeDir={machine.metadata?.homeDir || '/home'}
                        selectedPath={customPath}
                        onChangeSelectedPath={setCustomPath}
                        submitBehavior="confirm"
                        onSubmitSelectedPath={handleSelectPath}
                        recentPaths={recentPaths}
                        usePickerSearch={usePathPickerSearch}
                        searchVariant="none"
                        searchQuery={pathSearchQuery}
                        onChangeSearchQuery={setPathSearchQuery}
                        favoriteDirectories={favoriteDirectories}
                        onChangeFavoriteDirectories={setFavoriteDirectories}
                    />
                </View>
            </ItemList>
        </>
    );
});
