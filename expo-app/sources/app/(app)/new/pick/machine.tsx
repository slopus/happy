import React from 'react';
import { ActivityIndicator, Pressable, Text, View, Platform } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { CommonActions } from '@react-navigation/native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { MachineSelector } from '@/components/newSession/MachineSelector';
import { getRecentMachinesFromSessions } from '@/utils/recentMachines';
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/sync/sync';
import { prefetchMachineCapabilities } from '@/hooks/useMachineCapabilitiesCache';
import { invalidateMachineEnvPresence } from '@/hooks/useMachineEnvPresence';

export default React.memo(function MachinePickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const machines = useAllMachines();
    const sessions = useSessions();
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');

    const selectedMachine = machines.find(m => m.id === params.selectedId) || null;

    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const selectedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;

    const handleRefresh = React.useCallback(async () => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        try {
            // Always refresh the machine list (new machines / metadata updates).
            await sync.refreshMachinesThrottled({ staleMs: 0, force: true });

            // Refresh machine-scoped caches only for the currently-selected machine (if any).
            if (selectedMachineId) {
                invalidateMachineEnvPresence({ machineId: selectedMachineId });
                await Promise.all([
                    prefetchMachineCapabilities({ machineId: selectedMachineId, request: { checklistId: 'new-session' } }),
                ]);
            }
        } finally {
            setIsRefreshing(false);
        }
    }, [isRefreshing, selectedMachineId]);

    const handleSelectMachine = (machine: typeof machines[0]) => {
        // Support both callback pattern (feature branch wizard) and navigation params (main)
        const machineId = machine.id;

        // Navigation params approach from main for backward compatibility
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ machineId }),
                source: previousRoute.key,
            });
        }

        router.back();
    };

    // Compute recent machines from sessions
    const recentMachines = React.useMemo(() => {
        return getRecentMachinesFromSessions({ machines, sessions });
    }, [sessions, machines]);

    if (machines.length === 0) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: t('newSession.selectMachineTitle'),
                        headerBackTitle: t('common.back'),
                        // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
                        // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
                        presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
                        headerLeft: () => (
                            <Pressable
                                onPress={() => router.back()}
                                hitSlop={10}
                                style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.back')}
                            >
                                <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
                            </Pressable>
                        ),
                        headerRight: () => (
                            <Pressable
                                onPress={() => { void handleRefresh(); }}
                                hitSlop={10}
                                style={{ padding: 2 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.refresh')}
                                disabled={isRefreshing}
                            >
                                {isRefreshing
                                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    : <Ionicons name="refresh-outline" size={20} color={theme.colors.textSecondary} />}
                            </Pressable>
                        ),
                    }}
                />
                <View style={styles.container}>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            {t('newSession.noMachinesFound')}
                        </Text>
                    </View>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('newSession.selectMachineTitle'),
                    headerBackTitle: t('common.back'),
                    presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
                    headerLeft: () => (
                        <Pressable
                            onPress={() => router.back()}
                            hitSlop={10}
                            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.back')}
                        >
                            <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
                        </Pressable>
                    ),
                    headerRight: () => (
                        <Pressable
                            onPress={() => { void handleRefresh(); }}
                            hitSlop={10}
                            style={{ padding: 2 }}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.refresh')}
                            disabled={isRefreshing}
                        >
                            {isRefreshing
                                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                : <Ionicons name="refresh-outline" size={20} color={theme.colors.textSecondary} />}
                        </Pressable>
                    ),
                }}
            />
            <ItemList>
                <MachineSelector
                    machines={machines}
                    selectedMachine={selectedMachine}
                    recentMachines={recentMachines}
                    favoriteMachines={machines.filter(m => favoriteMachines.includes(m.id))}
                    onSelect={handleSelectMachine}
                    showFavorites={true}
                    showSearch={useMachinePickerSearch}
                    onToggleFavorite={(machine) => {
                        const isInFavorites = favoriteMachines.includes(machine.id);
                        setFavoriteMachines(isInFavorites
                            ? favoriteMachines.filter(id => id !== machine.id)
                            : [...favoriteMachines, machine.id]
                        );
                    }}
                />
            </ItemList>
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
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
}));
