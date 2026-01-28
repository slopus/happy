/**
 * Moltbot View
 *
 * Main view for Moltbot machines list and management.
 * This is the entry point for the Moltbot tab.
 */

import * as React from 'react';
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useAllMoltbotMachines, useIsDataReady, useAllMachines } from '@/sync/storage';
import type { MoltbotMachine } from '@/moltbot/types';
import type { Machine } from '@/sync/storageTypes';
import { StatusDot } from './StatusDot';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyIcon: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyDescription: {
        fontSize: 16,
        ...Typography.default(),
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: 24,
    },
    addButton: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
    },
    addButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    machineIcon: {
        width: 32,
        height: 32,
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    statusText: {
        fontSize: 12,
        ...Typography.default(),
    },
}));

interface MoltbotMachineCardProps {
    machine: MoltbotMachine;
    happyMachine?: Machine | null;
    onPress: () => void;
}

const MoltbotMachineCard = React.memo(({ machine, happyMachine, onPress }: MoltbotMachineCardProps) => {
    const { theme } = useUnistyles();

    // Determine machine name
    const name = machine.metadata?.name || (machine.type === 'happy' ? happyMachine?.metadata?.host : machine.directConfig?.url) || 'Unknown Machine';

    // Determine connection type and status
    const isOnline = machine.type === 'happy' ? happyMachine?.active : true; // Direct connections are assumed available
    const typeLabel = machine.type === 'happy' ? t('moltbot.machineTypeHappy') : t('moltbot.machineTypeDirect');

    const statusElement = (
        <View style={styles.statusContainer}>
            <StatusDot
                color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                isPulsing={false}
                size={6}
            />
            <Text style={[styles.statusText, { color: isOnline ? theme.colors.status.connected : theme.colors.status.disconnected }]}>
                {isOnline ? t('status.online') : t('status.offline')}
            </Text>
        </View>
    );

    const iconElement = (
        <Image
            source={require('@/assets/images/brutalist/Brutalism 3.png')}
            contentFit="contain"
            style={styles.machineIcon}
            tintColor={theme.colors.text}
        />
    );

    return (
        <Item
            title={name}
            subtitle={typeLabel}
            subtitleLines={1}
            leftElement={iconElement}
            rightElement={statusElement}
            onPress={onPress}
            showChevron={true}
        />
    );
});

export const MoltbotView = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const isDataReady = useIsDataReady();
    const moltbotMachines = useAllMoltbotMachines();
    const happyMachines = useAllMachines();

    // Create a map of Happy machines by ID for quick lookup
    const happyMachinesMap = React.useMemo(() => {
        const map = new Map<string, Machine>();
        for (const machine of happyMachines) {
            map.set(machine.id, machine);
        }
        return map;
    }, [happyMachines]);

    const handleMachinePress = React.useCallback((machineId: string) => {
        router.push(`/moltbot/machine/${machineId}`);
    }, [router]);

    const handleAddMachine = React.useCallback(() => {
        router.push('/moltbot/add');
    }, [router]);

    // Loading state
    if (!isDataReady) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                </View>
            </View>
        );
    }

    // Empty state
    if (moltbotMachines.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyContainer}>
                    <Image
                        source={require('@/assets/images/brutalist/Brutalism 3.png')}
                        contentFit="contain"
                        style={[{ width: 64, height: 64 }, styles.emptyIcon]}
                        tintColor={theme.colors.textSecondary}
                    />
                    <Text style={styles.emptyTitle}>{t('moltbot.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('moltbot.emptyDescription')}</Text>
                    <Pressable style={styles.addButton} onPress={handleAddMachine}>
                        <Text style={styles.addButtonText}>{t('moltbot.addMachine')}</Text>
                    </Pressable>
                </View>
            </View>
        );
    }

    // List view
    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={{
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                width: '100%',
                paddingBottom: 24,
            }}>
                <ItemGroup>
                    {moltbotMachines.map((machine) => (
                        <MoltbotMachineCard
                            key={machine.id}
                            machine={machine}
                            happyMachine={machine.type === 'happy' && machine.happyMachineId ? happyMachinesMap.get(machine.happyMachineId) : null}
                            onPress={() => handleMachinePress(machine.id)}
                        />
                    ))}
                </ItemGroup>
            </ScrollView>
        </View>
    );
});
