/**
 * OpenClaw View
 *
 * Main view for OpenClaw machines list and management.
 * This is the entry point for the OpenClaw tab.
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
import { useAllOpenClawMachines, useIsDataReady, useAllMachines, useOpenClawDirectStatus } from '@/sync/storage';
import type { OpenClawMachine } from '@/openclaw/types';
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
        color: theme.colors.button.primary.tint,
        fontSize: 16,
        ...Typography.default('semiBold'),
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

interface OpenClawMachineCardProps {
    machine: OpenClawMachine;
    happyMachine?: Machine | null;
    onPress: () => void;
    showDivider?: boolean;
}

const OpenClawMachineCard = React.memo(({ machine, happyMachine, onPress, showDivider = true }: OpenClawMachineCardProps) => {
    const { theme } = useUnistyles();
    const directStatus = useOpenClawDirectStatus(machine.id);

    // Determine machine name
    const name = machine.metadata?.name || (machine.type === 'happy' ? happyMachine?.metadata?.host : machine.directConfig?.url) || 'Unknown Machine';

    // Determine connection type and status
    const typeLabel = machine.type === 'happy' ? t('openclaw.machineTypeHappy') : t('openclaw.machineTypeDirect');

    // Status for display: Happy machines use heartbeat, direct machines use last known status
    const { statusColor, statusText } = React.useMemo(() => {
        if (machine.type === 'happy') {
            const isOnline = happyMachine?.active ?? false;
            return {
                statusColor: isOnline ? theme.colors.status.connected : theme.colors.status.disconnected,
                statusText: isOnline ? t('status.online') : t('status.offline'),
            };
        }
        // Direct machines: use last known status from store
        if (directStatus === 'connected') {
            return { statusColor: theme.colors.status.connected, statusText: t('status.online') };
        }
        if (directStatus === 'disconnected' || directStatus === 'error') {
            return { statusColor: theme.colors.status.disconnected, statusText: t('status.offline') };
        }
        // Never connected: unknown
        return { statusColor: theme.colors.textSecondary, statusText: t('status.unknown') };
    }, [machine.type, happyMachine?.active, directStatus, theme]);

    const statusElement = (
        <View style={styles.statusContainer}>
            <StatusDot
                color={statusColor}
                isPulsing={false}
                size={6}
            />
            <Text style={[styles.statusText, { color: statusColor }]}>
                {statusText}
            </Text>
        </View>
    );

    const iconElement = (
        <Image
            source={require('@/assets/images/brutalist/Brutalism 117.png')}
            contentFit="contain"
            style={{ width: 32, height: 32 }}
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
            showDivider={showDivider}
        />
    );
});

export const OpenClawView = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const isDataReady = useIsDataReady();
    const openClawMachines = useAllOpenClawMachines();
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
        router.push(`/openclaw/machine/${machineId}`);
    }, [router]);

    const handleAddMachine = React.useCallback(() => {
        router.push('/openclaw/add');
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
    if (openClawMachines.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyContainer}>
                    <Image
                        source={require('@/assets/images/brutalist/Brutalism 117.png')}
                        contentFit="contain"
                        style={[{ width: 64, height: 64 }, styles.emptyIcon]}
                        tintColor={theme.colors.textSecondary}
                    />
                    <Text style={styles.emptyTitle}>{t('openclaw.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('openclaw.emptyDescription')}</Text>
                    <Pressable style={styles.addButton} onPress={handleAddMachine}>
                        <Text style={styles.addButtonText}>{t('openclaw.addMachine')}</Text>
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
                    {openClawMachines.map((machine, index) => (
                        <OpenClawMachineCard
                            key={machine.id}
                            machine={machine}
                            happyMachine={machine.type === 'happy' && machine.happyMachineId ? happyMachinesMap.get(machine.happyMachineId) : null}
                            onPress={() => handleMachinePress(machine.id)}
                            showDivider={index < openClawMachines.length - 1}
                        />
                    ))}
                </ItemGroup>
            </ScrollView>
        </View>
    );
});
