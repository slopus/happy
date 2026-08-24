import React, { useState, useMemo } from 'react';
import { View, Text, ActivityIndicator, RefreshControl, Pressable, Platform } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines, useMachine } from '@/sync/storage';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { machineStopDaemon, machineUpdateMetadata, machineDelete } from '@/sync/ops';
import { Modal } from '@/modal';
import { getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';

export default function MachineDetailScreen() {
    const { theme } = useUnistyles();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const sessions = useSessions();
    const machine = useMachine(machineId!);
    const navigateToSession = useNavigateToSession();
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isStoppingDaemon, setIsStoppingDaemon] = useState(false);
    const [isRenamingMachine, setIsRenamingMachine] = useState(false);
    const [isDeletingMachine, setIsDeletingMachine] = useState(false);

    const machineSessions = useMemo(() => {
        if (!sessions || !machineId) return [];

        return sessions.filter(item => {
            if (typeof item === 'string') return false;
            const session = item as Session;
            return session.metadata?.machineId === machineId;
        }) as Session[];
    }, [sessions, machineId]);

    const previousSessions = useMemo(() => {
        return [...machineSessions]
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 5);
    }, [machineSessions]);

    const handleStopDaemon = async () => {
        // Show confirmation modal using alert with buttons
        Modal.alert(
            'Stop Daemon?',
            'You will not be able to spawn new sessions on this machine until you restart the daemon on your computer again. Your current sessions will stay alive.',
            [
                {
                    text: 'Cancel',
                    style: 'cancel'
                },
                {
                    text: 'Stop Daemon',
                    style: 'destructive',
                    onPress: async () => {
                        setIsStoppingDaemon(true);
                        try {
                            const result = await machineStopDaemon(machineId!);
                            Modal.alert('Daemon Stopped', result.message);
                            // Refresh to get updated metadata
                            await sync.refreshMachines();
                        } catch (error) {
                            Modal.alert(t('common.error'), 'Failed to stop daemon. It may not be running.');
                        } finally {
                            setIsStoppingDaemon(false);
                        }
                    }
                }
            ]
        );
    };

    const handleRefresh = async () => {
        setIsRefreshing(true);
        await sync.refreshMachines();
        setIsRefreshing(false);
    };

    const handleDeleteMachine = async () => {
        if (!machineId) return;
        const confirmed = await Modal.confirm(
            t('machine.deleteConfirmTitle'),
            t('machine.deleteConfirmMessage'),
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true }
        );
        if (!confirmed) return;

        setIsDeletingMachine(true);
        try {
            const result = await machineDelete(machineId);
            if (result.success) {
                router.back();
            } else {
                Modal.alert(t('common.error'), result.message || t('machine.deleteFailed'));
            }
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('machine.deleteFailed')
            );
        } finally {
            setIsDeletingMachine(false);
        }
    };

    const handleRenameMachine = async () => {
        if (!machine || !machineId) return;

        const newDisplayName = await Modal.prompt(
            'Rename Machine',
            'Give this machine a custom name. Leave empty to use the default hostname.',
            {
                defaultValue: machine.metadata?.displayName || '',
                placeholder: machine.metadata?.host || 'Enter machine name',
                cancelText: t('common.cancel'),
                confirmText: t('common.rename')
            }
        );

        if (newDisplayName !== null) {
            setIsRenamingMachine(true);
            try {
                const updatedMetadata = {
                    ...machine.metadata!,
                    displayName: newDisplayName.trim() || undefined
                };
                
                await machineUpdateMetadata(
                    machineId,
                    updatedMetadata,
                    machine.metadataVersion
                );
                
                Modal.alert(t('common.success'), 'Machine renamed successfully');
            } catch (error) {
                Modal.alert(
                    'Error',
                    error instanceof Error ? error.message : 'Failed to rename machine'
                );
                // Refresh to get latest state
                await sync.refreshMachines();
            } finally {
                setIsRenamingMachine(false);
            }
        }
    };

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: '',
                        headerBackTitle: t('machine.back')
                    }}
                />
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.groupped.background }}>
                    <Text style={[Typography.default(), { fontSize: 16, color: '#666' }]}>
                        Machine not found
                    </Text>
                </View>
            </>
        );
    }

    const metadata = machine.metadata;
    const machineName = metadata?.displayName || metadata?.host || 'unknown machine';
    const machineOnline = isMachineOnline(machine);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: machineName,
                    headerRight: () => (
                        <Pressable
                            onPress={handleRenameMachine}
                            hitSlop={10}
                            style={{
                                opacity: isRenamingMachine ? 0.5 : 1
                            }}
                            disabled={isRenamingMachine}
                        >
                            <Octicons
                                name="pencil"
                                size={24}
                                color={theme.colors.text}
                            />
                        </Pressable>
                    ),
                    headerBackTitle: t('machine.back')
                }}
            />
            <ItemList
                containerStyle={{
                    paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                    />
                }
                keyboardShouldPersistTaps="handled"
            >
                {/* Daemon */}
                <ItemGroup>
                        <Item
                            title={t('machine.status')}
                            detail={machineOnline ? t('status.online') : t('status.offline')}
                            detailStyle={{
                                color: machineOnline ? '#34C759' : theme.colors.textSecondary
                            }}
                            showChevron={false}
                        />
                        <Item
                            title={t('machine.stopDaemon')}
                            titleStyle={{
                                color: machineOnline ? '#FF9500' : theme.colors.textSecondary
                            }}
                            onPress={machineOnline ? handleStopDaemon : undefined}
                            disabled={isStoppingDaemon || !machineOnline}
                            rightElement={
                                isStoppingDaemon ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : (
                                    <Ionicons 
                                        name="stop-circle" 
                                        size={20} 
                                        color={machineOnline ? '#FF9500' : theme.colors.textSecondary}
                                    />
                                )
                            }
                        />
                        {machine.daemonState && (
                            <>
                                {machine.daemonState.pid && (
                                    <Item
                                        title={t('machine.lastKnownPid')}
                                        subtitle={String(machine.daemonState.pid)}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                                {machine.daemonState.httpPort && (
                                    <Item
                                        title={t('machine.lastKnownHttpPort')}
                                        subtitle={String(machine.daemonState.httpPort)}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                                {machine.daemonState.startTime && (
                                    <Item
                                        title={t('machine.startedAt')}
                                        subtitle={new Date(machine.daemonState.startTime).toLocaleString()}
                                    />
                                )}
                                {machine.daemonState.startedWithCliVersion && (
                                    <Item
                                        title={t('machine.cliVersion')}
                                        subtitle={machine.daemonState.startedWithCliVersion}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                            </>
                        )}
                        <Item
                            title={t('machine.daemonStateVersion')}
                            subtitle={String(machine.daemonStateVersion)}
                        />
                </ItemGroup>

                {/* CLI Availability */}
                {metadata?.cliAvailability && (
                    <ItemGroup title={t('machine.cliAvailability')}>
                        <Item
                            title="Claude"
                            showChevron={false}
                            rightElement={
                                <Text style={{ color: metadata.cliAvailability.claude ? '#34C759' : theme.colors.textSecondary, fontSize: 14 }}>
                                    {metadata.cliAvailability.claude ? t('machine.cliInstalled') : t('machine.cliNotFound')}
                                </Text>
                            }
                        />
                        <Item
                            title="Codex"
                            showChevron={false}
                            rightElement={
                                <Text style={{ color: metadata.cliAvailability.codex ? '#34C759' : theme.colors.textSecondary, fontSize: 14 }}>
                                    {metadata.cliAvailability.codex ? t('machine.cliInstalled') : t('machine.cliNotFound')}
                                </Text>
                            }
                        />
                        <Item
                            title="Gemini"
                            showChevron={false}
                            rightElement={
                                <Text style={{ color: metadata.cliAvailability.gemini ? '#34C759' : theme.colors.textSecondary, fontSize: 14 }}>
                                    {metadata.cliAvailability.gemini ? t('machine.cliInstalled') : t('machine.cliNotFound')}
                                </Text>
                            }
                        />
                        <Item
                            title="OpenClaw"
                            showChevron={false}
                            rightElement={
                                <Text style={{ color: metadata.cliAvailability.openclaw ? '#34C759' : theme.colors.textSecondary, fontSize: 14 }}>
                                    {metadata.cliAvailability.openclaw ? t('machine.cliInstalled') : t('machine.cliNotFound')}
                                </Text>
                            }
                        />
                        {metadata.cliAvailability.rig !== undefined && (
                            <Item
                                title="Rig"
                                showChevron={false}
                                rightElement={
                                    <Text style={{ color: metadata.cliAvailability.rig ? '#34C759' : theme.colors.textSecondary, fontSize: 14 }}>
                                        {metadata.cliAvailability.rig ? t('machine.cliInstalled') : t('machine.cliNotFound')}
                                    </Text>
                                }
                            />
                        )}
                        <Item
                            title={t('machine.lastDetected')}
                            subtitle={new Date(metadata.cliAvailability.detectedAt).toLocaleString()}
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                {/* Recent sessions */}
                {previousSessions.length > 0 && (
                    <ItemGroup title={t('tabs.sessions')}>
                        {previousSessions.map(session => (
                            <Item
                                key={session.id}
                                title={getSessionName(session)}
                                subtitle={getSessionSubtitle(session)}
                                onPress={() => navigateToSession(session.id)}
                                rightElement={<Ionicons name="chevron-forward" size={20} color="#C7C7CC" />}
                            />
                        ))}
                    </ItemGroup>
                )}

                {/* Machine */}
                <ItemGroup title={t('machine.machineGroup')}>
                        <Item
                            title={t('machine.host')}
                            subtitle={metadata?.host || machineId}
                        />
                        <Item
                            title={t('machine.machineId')}
                            subtitle={machineId}
                            subtitleStyle={{ fontFamily: 'Menlo', fontSize: 12 }}
                        />
                        {metadata?.username && (
                            <Item
                                title={t('machine.username')}
                                subtitle={metadata.username}
                            />
                        )}
                        {metadata?.homeDir && (
                            <Item
                                title={t('machine.homeDirectory')}
                                subtitle={metadata.homeDir}
                                subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                            />
                        )}
                        {metadata?.platform && (
                            <Item
                                title={t('machine.platform')}
                                subtitle={metadata.platform}
                            />
                        )}
                        {metadata?.arch && (
                            <Item
                                title={t('machine.architecture')}
                                subtitle={metadata.arch}
                            />
                        )}
                        <Item
                            title={t('machine.lastSeen')}
                            subtitle={machine.activeAt ? new Date(machine.activeAt).toLocaleString() : t('machine.never')}
                        />
                        <Item
                            title={t('machine.metadataVersion')}
                            subtitle={String(machine.metadataVersion)}
                        />
                </ItemGroup>

                {/* Danger zone */}
                <ItemGroup title={t('machine.dangerZone')} footer={t('machine.deleteFooter')}>
                    <Item
                        title={t('machine.delete')}
                        titleStyle={{ color: '#FF3B30' }}
                        onPress={handleDeleteMachine}
                        disabled={isDeletingMachine}
                        showChevron={false}
                        rightElement={
                            isDeletingMachine ? (
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            ) : (
                                <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                            )
                        }
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
