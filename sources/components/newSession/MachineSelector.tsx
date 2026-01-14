import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SearchableListSelector } from '@/components/SearchableListSelector';
import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline } from '@/utils/machineUtils';

export interface MachineSelectorProps {
    machines: Machine[];
    selectedMachine: Machine | null;
    recentMachines?: Machine[];
    favoriteMachines?: Machine[];
    onSelect: (machine: Machine) => void;
    onToggleFavorite?: (machine: Machine) => void;
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
    searchPlacement?: 'header' | 'recent' | 'favorites' | 'all';
    searchPlaceholder?: string;
    recentSectionTitle?: string;
    favoritesSectionTitle?: string;
    allSectionTitle?: string;
    noItemsMessage?: string;
}

export function MachineSelector({
    machines,
    selectedMachine,
    recentMachines = [],
    favoriteMachines = [],
    onSelect,
    onToggleFavorite,
    showFavorites = true,
    showRecent = true,
    showSearch = true,
    searchPlacement = 'header',
    searchPlaceholder = 'Type to filter machines...',
    recentSectionTitle = 'Recent Machines',
    favoritesSectionTitle = 'Favorite Machines',
    allSectionTitle = 'All Machines',
    noItemsMessage = 'No machines available',
}: MachineSelectorProps) {
    const { theme } = useUnistyles();

    return (
        <SearchableListSelector<Machine>
            config={{
                getItemId: (machine) => machine.id,
                getItemTitle: (machine) => machine.metadata?.displayName || machine.metadata?.host || machine.id,
                getItemSubtitle: undefined,
                getItemIcon: () => (
                    <Ionicons
                        name="desktop-outline"
                        size={24}
                        color={theme.colors.textSecondary}
                    />
                ),
                getRecentItemIcon: () => (
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
                searchPlaceholder,
                recentSectionTitle,
                favoritesSectionTitle,
                allSectionTitle,
                noItemsMessage,
                showFavorites,
                showRecent,
                showSearch,
                allowCustomInput: false,
            }}
            items={machines}
            recentItems={recentMachines}
            favoriteItems={favoriteMachines}
            selectedItem={selectedMachine}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
            searchPlacement={searchPlacement}
        />
    );
}
