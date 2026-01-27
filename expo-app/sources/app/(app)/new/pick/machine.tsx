import React from 'react';
import { Pressable, Text, View, Platform } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { CommonActions } from '@react-navigation/native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/sync/sync';
import { prefetchMachineCapabilities } from '@/hooks/useMachineCapabilitiesCache';
import { invalidateMachineEnvPresence } from '@/hooks/useMachineEnvPresence';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';

function useMachinePickerScreenOptions(params: {
    title: string;
    onBack: () => void;
    onRefresh: () => void;
    isRefreshing: boolean;
    theme: { colors: { header: { tint: string }; textSecondary: string } };
}) {
    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={params.onBack}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Ionicons name="chevron-back" size={22} color={params.theme.colors.header.tint} />
        </Pressable>
    ), [params.onBack, params.theme.colors.header.tint]);

    const headerTitle = React.useCallback(({ tintColor }: { children: string; tintColor?: string }) => (
        <HeaderTitleWithAction
            title={params.title}
            tintColor={tintColor ?? params.theme.colors.header.tint}
            actionLabel={t('common.refresh')}
            actionIconName="refresh-outline"
            actionColor={params.theme.colors.textSecondary}
            actionDisabled={params.isRefreshing}
            actionLoading={params.isRefreshing}
            onActionPress={params.onRefresh}
        />
    ), [params.isRefreshing, params.onRefresh, params.theme.colors.header.tint, params.theme.colors.textSecondary, params.title]);

    return React.useMemo(() => ({
        headerShown: true,
        title: params.title,
        headerTitle,
        headerBackTitle: t('common.back'),
        // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
        // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
        presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
        headerLeft,
    }), [headerLeft, headerTitle]);
}

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
                    prefetchMachineCapabilities({ machineId: selectedMachineId, request: CAPABILITIES_REQUEST_NEW_SESSION }),
                ]);
            }
        } finally {
            setIsRefreshing(false);
        }
    }, [isRefreshing, selectedMachineId]);

    const screenOptions = useMachinePickerScreenOptions({
        title: t('newSession.selectMachineTitle'),
        onBack: () => router.back(),
        onRefresh: () => { void handleRefresh(); },
        isRefreshing,
        theme,
    });

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
                <Stack.Screen options={screenOptions} />
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
            <Stack.Screen options={screenOptions} />
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
