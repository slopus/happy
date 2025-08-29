import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Platform, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines } from '@/sync/storage';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { machineSpawnNewSession, machineStopDaemon, machineUpdateMetadata } from '@/sync/ops';
import { Modal } from '@/modal';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { MachineSessionLauncher } from '@/components/MachineSessionLauncher';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

export default function MachineDetailScreen() {
    const { theme } = useUnistyles();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const sessions = useSessions();
    const machines = useAllMachines();
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isStoppingDaemon, setIsStoppingDaemon] = useState(false);
    const [isRenamingMachine, setIsRenamingMachine] = useState(false);

    const machine = useMemo(() => {
        return machines.find(m => m.id === machineId);
    }, [machines, machineId]);

    const machineSessions = useMemo(() => {
        if (!sessions || !machineId) return [];

        return sessions.filter(item => {
            if (typeof item === 'string') return false;
            const session = item as Session;
            return session.metadata?.machineId === machineId;
        }) as Session[];
    }, [sessions, machineId]);

    const recentPaths = useMemo(() => {
        const paths = new Set<string>();
        machineSessions.forEach(session => {
            if (session.metadata?.path) {
                paths.add(session.metadata.path);
            }
        });
        return Array.from(paths).sort();
    }, [machineSessions]);

    // Determine daemon status from metadata
    const daemonStatus = useMemo(() => {
        if (!machine) return 'unknown';

        // Check metadata for daemon status
        const metadata = machine.metadata as any;
        if (metadata?.daemonLastKnownStatus === 'shutting-down') {
            return 'stopped';
        }

        // Use machine online status as proxy for daemon status
        return isMachineOnline(machine) ? 'likely alive' : 'stopped';
    }, [machine]);

    const handleStartSession = async (path: string) => {
        if (!machineId) return;

        try {
            console.log(`🚀 Starting session on machine ${machineId} at path: ${path}`);
            const result = await machineSpawnNewSession(machineId, path);
            console.log('🎉 daemon result', result);

            if (result.sessionId) {
                console.log('✅ Session spawned successfully:', result.sessionId);

                // Poll for the session to appear
                const pollInterval = 100;
                const maxAttempts = 20;
                let attempts = 0;

                const pollForSession = () => {
                    const state = storage.getState();
                    const newSession = Object.values(state.sessions).find((s: Session) => s.id === result.sessionId);

                    if (newSession) {
                        console.log('📱 Navigating to session:', result.sessionId);
                        router.replace(`/session/${result.sessionId}`);
                        return;
                    }

                    attempts++;
                    if (attempts < maxAttempts) {
                        setTimeout(pollForSession, pollInterval);
                    } else {
                        console.log('⏰ Polling timeout - session should appear soon');
                        Modal.alert(t('newSession.sessionStarted'), t('newSession.sessionStartedMessage'));
                    }
                };

                pollForSession();
            } else {
                console.error('❌ No sessionId in response:', result);
                throw new Error('Session spawning failed - no session ID returned.');
            }
        } catch (error) {
            console.error('💥 Failed to start session', error);

            let errorMessage = 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error) {
                if (error.message.includes('timeout')) {
                    errorMessage = 'Session startup timed out. The machine may be slow or the daemon may not be responding.';
                } else if (error.message.includes('Socket not connected')) {
                    errorMessage = 'Not connected to server. Check your internet connection.';
                }
            }

            Modal.alert(t('common.error'), errorMessage);
            throw error;
        }
    };

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
                    t('common.error'),
                    error instanceof Error ? error.message : 'Failed to rename machine'
                );
                // Refresh to get latest state
                await sync.refreshMachines();
            } finally {
                setIsRenamingMachine(false);
            }
        }
    };

    const pastUsedRelativePath = useCallback((session: Session) => {
        if (!session.metadata) return 'unknown path';
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }, []);

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: '',
                        headerBackTitle: 'Back'
                    }}
                />
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={[Typography.default(), { fontSize: 16, color: '#666' }]}>
                        Machine not found
                    </Text>
                </View>
            </>
        );
    }

    const metadata = machine.metadata;
    const machineName = metadata?.displayName || metadata?.host || 'unknown machine';

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: () => (
                        <View style={{ alignItems: 'center' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Ionicons
                                    name="desktop-outline"
                                    size={18}
                                    color={theme.colors.header.tint}
                                    style={{ marginRight: 6 }}
                                />
                                <Text style={[Typography.default('semiBold'), { fontSize: 17, color: theme.colors.header.tint }]}>
                                    {machineName}
                                </Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                                <View style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 3,
                                    backgroundColor: isMachineOnline(machine) ? '#34C759' : '#999',
                                    marginRight: 4
                                }} />
                                <Text style={[Typography.default(), {
                                    fontSize: 12,
                                    color: isMachineOnline(machine) ? '#34C759' : '#999'
                                }]}
                                >
                                    {isMachineOnline(machine) ? t('status.online') : t('status.offline')}
                                </Text>
                            </View>
                        </View>
                    ),
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
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                    />
                }
            >
                {/* Launch New Session section with launcher */}
                <ItemGroup title={t('machine.launchNewSessionInDirectory')}>
                        <MachineSessionLauncher
                            machineId={machineId!}
                            recentPaths={recentPaths}
                            homeDir={metadata?.homeDir}
                            isOnline={isMachineOnline(machine)}
                            onStartSession={handleStartSession}
                        />
                </ItemGroup>

                {/* Daemon */}
                <ItemGroup title={t('machine.daemon')}>
                        <Item
                            title={t('machine.status')}
                            detail={daemonStatus}
                            detailStyle={{
                                color: daemonStatus === 'likely alive' ? '#34C759' : '#FF9500'
                            }}
                            showChevron={false}
                        />
                        <Item
                            title={t('machine.stopDaemon')}
                            titleStyle={{ 
                                color: daemonStatus === 'stopped' ? '#999' : '#FF9500' 
                            }}
                            onPress={daemonStatus === 'stopped' ? undefined : handleStopDaemon}
                            disabled={isStoppingDaemon || daemonStatus === 'stopped'}
                            rightElement={
                                isStoppingDaemon ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : (
                                    <Ionicons 
                                        name="stop-circle" 
                                        size={20} 
                                        color={daemonStatus === 'stopped' ? '#999' : '#FF9500'} 
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

                {/* Active Sessions */}
                {machineSessions.length > 0 && (
                    <ItemGroup title={t('machine.activeSessions', { count: machineSessions.length })}>
                        {machineSessions.slice(0, 5).map(session => (
                                <Item
                                    key={session.id}
                                    title={pastUsedRelativePath(session)}
                                    subtitle={session.metadata?.name || t('machine.untitledSession')}
                                    onPress={() => router.push(`/session/${session.id}`)}
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
            </ItemList>
        </>
    );
}
