import React from 'react';
import { View, Text } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { MachineSelector } from '@/components/newSession/MachineSelector';

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

    const handleSelectMachine = (machine: typeof machines[0]) => {
        // Support both callback pattern (feature branch wizard) and navigation params (main)
        const machineId = machine.id;

        // Navigation params approach from main for backward compatibility
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                type: 'SET_PARAMS',
                payload: { params: { machineId } },
                source: previousRoute.key,
            } as never);
        }

        router.back();
    };

    // Compute recent machines from sessions
    const recentMachines = React.useMemo(() => {
        const machineIds = new Set<string>();
        const machinesWithTimestamp: Array<{ machine: typeof machines[0]; timestamp: number }> = [];

        sessions?.forEach(item => {
            if (typeof item === 'string') return; // Skip section headers
            const session = item;
            const machineId = session.metadata?.machineId;
            if (machineId && !machineIds.has(machineId)) {
                const machine = machines.find(m => m.id === machineId);
                if (machine) {
                    machineIds.add(machine.id);
                    machinesWithTimestamp.push({
                        machine,
                        timestamp: session.updatedAt || session.createdAt,
                    });
                }
            }
        });

        return machinesWithTimestamp
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(item => item.machine);
    }, [sessions, machines]);

    if (machines.length === 0) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: t('newSession.selectMachineTitle'),
                        headerBackTitle: t('common.back')
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
                    headerBackTitle: t('common.back')
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
