import React from 'react';
import { View, Text } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { CommonActions, useNavigation } from '@react-navigation/native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { isMachineOnline } from '@/utils/machineUtils';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ItemList';
import { SearchableListSelector } from '@/components/SearchableListSelector';

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

export default function MachinePickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const machines = useAllMachines();
    const sessions = useSessions();

    const selectedMachine = machines.find(m => m.id === params.selectedId) || null;

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
            const session = item as any;
            if (session.metadata?.machineId && !machineIds.has(session.metadata.machineId)) {
                const machine = machines.find(m => m.id === session.metadata.machineId);
                if (machine) {
                    machineIds.add(machine.id);
                    machinesWithTimestamp.push({
                        machine,
                        timestamp: session.updatedAt || session.createdAt
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
                        headerTitle: 'Select Machine',
                        headerBackTitle: t('common.back')
                    }}
                />
                <View style={styles.container}>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            No machines available
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
                    headerTitle: 'Select Machine',
                    headerBackTitle: t('common.back')
                }}
            />
            <ItemList>
                <SearchableListSelector<typeof machines[0]>
                    config={{
                        getItemId: (machine) => machine.id,
                        getItemTitle: (machine) => machine.metadata?.displayName || machine.metadata?.host || machine.id,
                        getItemSubtitle: undefined,
                        getItemIcon: (machine) => (
                            <Ionicons
                                name="desktop-outline"
                                size={24}
                                color={theme.colors.textSecondary}
                            />
                        ),
                        getRecentItemIcon: (machine) => (
                            <Ionicons
                                name="time-outline"
                                size={24}
                                color={theme.colors.textSecondary}
                            />
                        ),
                        getItemStatus: (machine) => {
                            const offline = !isMachineOnline(machine);
                            return {
                                text: offline ? 'offline' : 'online',
                                color: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                                dotColor: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                                isPulsing: !offline,
                            };
                        },
                        formatForDisplay: (machine) => machine.metadata?.displayName || machine.metadata?.host || machine.id,
                        parseFromDisplay: (text) => {
                            return machines.find(m =>
                                m.metadata?.displayName === text || m.metadata?.host === text || m.id === text
                            ) || null;
                        },
                        filterItem: (machine, searchText) => {
                            const displayName = (machine.metadata?.displayName || '').toLowerCase();
                            const host = (machine.metadata?.host || '').toLowerCase();
                            const search = searchText.toLowerCase();
                            return displayName.includes(search) || host.includes(search);
                        },
                        searchPlaceholder: "Type to filter machines...",
                        recentSectionTitle: "Recent Machines",
                        favoritesSectionTitle: "Favorite Machines",
                        noItemsMessage: "No machines available",
                        showFavorites: false,  // Simpler modal experience - no favorites in modal
                        showRecent: true,
                        showSearch: true,
                        allowCustomInput: false,
                        compactItems: true,
                    }}
                    items={machines}
                    recentItems={recentMachines}
                    favoriteItems={[]}
                    selectedItem={selectedMachine}
                    onSelect={handleSelectMachine}
                />
            </ItemList>
        </>
    );
}