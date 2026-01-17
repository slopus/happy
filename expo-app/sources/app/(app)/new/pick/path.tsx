import React, { useState, useMemo } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { layout } from '@/components/layout';
import { PathSelector } from '@/components/newSession/PathSelector';
import { SearchHeader } from '@/components/SearchHeader';
import { getRecentPathsForMachine } from '@/utils/recentPaths';

export default React.memo(function PathPickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams<{ machineId?: string; selectedPath?: string }>();
    const machines = useAllMachines();
    const sessions = useSessions();
    const recentMachinePaths = useSetting('recentMachinePaths');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [favoriteDirectoriesRaw, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const favoriteDirectories = favoriteDirectoriesRaw ?? [];

    const [customPath, setCustomPath] = useState(params.selectedPath || '');
    const [pathSearchQuery, setPathSearchQuery] = useState('');

    // Get the selected machine
    const machine = useMemo(() => {
        return machines.find(m => m.id === params.machineId);
    }, [machines, params.machineId]);

    // Get recent paths for this machine - prioritize from settings, then fall back to sessions
    const recentPaths = useMemo(() => {
        if (!params.machineId) return [];
        return getRecentPathsForMachine({
            machineId: params.machineId,
            recentMachinePaths,
            sessions,
        });
    }, [params.machineId, recentMachinePaths, sessions]);


    const handleSelectPath = React.useCallback((pathOverride?: string) => {
        const rawPath = typeof pathOverride === 'string' ? pathOverride : customPath;
        const pathToUse = rawPath.trim() || machine?.metadata?.homeDir || '/home';
        router.setParams({ path: pathToUse });
        router.back();
    }, [customPath, router, machine]);

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
                    ),
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
