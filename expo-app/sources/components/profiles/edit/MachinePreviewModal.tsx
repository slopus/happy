import React from 'react';
import { View, Text, Pressable, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import type { Machine } from '@/sync/storageTypes';

export interface MachinePreviewModalProps {
    machines: Machine[];
    favoriteMachineIds: string[];
    selectedMachineId: string | null;
    onSelect: (machineId: string) => void;
    onToggleFavorite: (machineId: string) => void;
    onClose: () => void;
}

export function MachinePreviewModal(props: MachinePreviewModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { height: windowHeight } = useWindowDimensions();

    const selectedMachine = React.useMemo(() => {
        if (!props.selectedMachineId) return null;
        return props.machines.find((m) => m.id === props.selectedMachineId) ?? null;
    }, [props.machines, props.selectedMachineId]);

    const favoriteMachines = React.useMemo(() => {
        const byId = new Map(props.machines.map((m) => [m.id, m] as const));
        return props.favoriteMachineIds.map((id) => byId.get(id)).filter(Boolean) as Machine[];
    }, [props.favoriteMachineIds, props.machines]);

    const maxHeight = Math.min(720, Math.max(420, Math.floor(windowHeight * 0.85)));

    return (
        <View style={[styles.machinePreviewModalContainer, { height: maxHeight, maxHeight }]}>
            <View style={styles.machinePreviewModalHeader}>
                <Text style={styles.machinePreviewModalTitle}>{t('profiles.previewMachine.title')}</Text>

                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={{ flex: 1 }}>
                <MachineSelector
                    machines={props.machines}
                    selectedMachine={selectedMachine}
                    favoriteMachines={favoriteMachines}
                    showRecent={false}
                    showFavorites={favoriteMachines.length > 0}
                    showSearch
                    searchPlacement={favoriteMachines.length > 0 ? 'favorites' : 'all'}
                    onSelect={(machine) => {
                        props.onSelect(machine.id);
                        props.onClose();
                    }}
                    onToggleFavorite={(machine) => props.onToggleFavorite(machine.id)}
                />
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    machinePreviewModalContainer: {
        width: '92%',
        maxWidth: 560,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexShrink: 1,
    },
    machinePreviewModalHeader: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    machinePreviewModalTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));
