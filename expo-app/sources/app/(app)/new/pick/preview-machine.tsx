import React from 'react';
import { Platform, Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(function PreviewMachinePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const machines = useAllMachines();
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');

    const selectedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;
    const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;

    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={() => router.back()}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
        </Pressable>
    ), [router, theme.colors.header.tint]);

    const screenOptions = React.useCallback(() => {
        return {
            headerShown: true,
            title: t('profiles.previewMachine.title'),
            headerBackTitle: t('common.back'),
            presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
            headerLeft,
        } as const;
    }, [headerLeft]);

    const favoriteMachineList = React.useMemo(() => {
        const byId = new Map(machines.map((m) => [m.id, m] as const));
        return favoriteMachines.map((id) => byId.get(id)).filter(Boolean) as typeof machines;
    }, [favoriteMachines, machines]);

    const toggleFavorite = React.useCallback((machineId: string) => {
        if (favoriteMachines.includes(machineId)) {
            setFavoriteMachines(favoriteMachines.filter((id) => id !== machineId));
            return;
        }
        setFavoriteMachines([...favoriteMachines, machineId]);
    }, [favoriteMachines, setFavoriteMachines]);

    const setPreviewMachineIdOnPreviousRoute = React.useCallback((previewMachineId: string) => {
        const state = (navigation as any)?.getState?.();
        const previousRoute = state?.routes?.[state.index - 1];
        if (!state || typeof state.index !== 'number' || state.index <= 0 || !previousRoute?.key) {
            return false;
        }
        (navigation as any).dispatch({
            type: 'SET_PARAMS',
            payload: { params: { previewMachineId } },
            source: previousRoute.key,
        });
        return true;
    }, [navigation]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ItemList>
                <MachineSelector
                    machines={machines}
                    selectedMachine={selectedMachine}
                    favoriteMachines={favoriteMachineList}
                    showRecent={false}
                    showFavorites={favoriteMachineList.length > 0}
                    showSearch
                    searchPlacement={favoriteMachineList.length > 0 ? 'favorites' : 'all'}
                    onSelect={(machine) => {
                        setPreviewMachineIdOnPreviousRoute(machine.id);
                        router.back();
                    }}
                    onToggleFavorite={(machine) => toggleFavorite(machine.id)}
                />
            </ItemList>
        </>
    );
});
