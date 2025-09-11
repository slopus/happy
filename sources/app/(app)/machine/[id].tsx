import React, { useState, useMemo, useCallback, useRef } from 'react';
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Platform, Pressable, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines, useMachine } from '@/sync/storage';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { machineStopDaemon, machineUpdateMetadata } from '@/sync/ops';
import { Modal } from '@/modal';
import { formatPathRelativeToHome, getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { sync } from '@/sync/sync';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { machineSpawnNewSession } from '@/sync/ops';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { MultiTextInput, type MultiTextInputHandle } from '@/components/MultiTextInput';

const styles = StyleSheet.create((theme) => ({
    pathInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    pathInput: {
        flex: 1,
        borderRadius: 8,
        backgroundColor: theme.colors.input?.background ?? theme.colors.groupped.background,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        minHeight: 44,
        position: 'relative',
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }) as any,
    },
    inlineSendButton: {
        position: 'absolute',
        right: 8,
        bottom: 10,
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    inlineSendActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    inlineSendInactive: {
        // Use a darker neutral in light theme to avoid blending into input
        backgroundColor: Platform.select({
            ios: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surfaceHigh,
            android: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surfaceHigh,
            default: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surfaceHigh,
        }) as any,
    },
}));

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
    const [customPath, setCustomPath] = useState('');
    const [isSpawning, setIsSpawning] = useState(false);
    const inputRef = useRef<MultiTextInputHandle>(null);
    const [showAllPaths, setShowAllPaths] = useState(false);
    // Variant D only

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

    const recentPaths = useMemo(() => {
        const paths = new Set<string>();
        machineSessions.forEach(session => {
            if (session.metadata?.path) {
                paths.add(session.metadata.path);
            }
        });
        return Array.from(paths).sort();
    }, [machineSessions]);

    const pathsToShow = useMemo(() => {
        if (showAllPaths) return recentPaths;
        return recentPaths.slice(0, 5);
    }, [recentPaths, showAllPaths]);

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

    // inline control below

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

    const handleStartSession = async (approvedNewDirectoryCreation: boolean = false): Promise<void> => {
        if (!machine || !machineId) return;
        try {
            const pathToUse = (customPath.trim() || '~');
            if (!isMachineOnline(machine)) return;
            setIsSpawning(true);
            const absolutePath = resolveAbsolutePath(pathToUse, machine?.metadata?.homeDir);
            const result = await machineSpawnNewSession({
                machineId: machineId!,
                directory: absolutePath,
                approvedNewDirectoryCreation
            });
            switch (result.type) {
                case 'success':
                    // Dismiss machine picker & machine detail screen
                    router.back();
                    router.back();
                    navigateToSession(result.sessionId);
                    break;
                case 'requestToApproveDirectoryCreation': {
                    const approved = await Modal.confirm('Create Directory?', `The directory '${result.directory}' does not exist. Would you like to create it?`, { cancelText: t('common.cancel'), confirmText: t('common.create') });
                    if (approved) {
                        await handleStartSession(true);
                    }
                    break;
                }
                case 'error':
                    Modal.alert(t('common.error'), result.errorMessage);
                    break;
            }
        } catch (error) {
            let errorMessage = 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error && !error.message.includes('Failed to spawn session')) {
                errorMessage = error.message;
            }
            Modal.alert(t('common.error'), errorMessage);
        } finally {
            setIsSpawning(false);
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
                        headerBackTitle: t('machine.back')
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

    const spawnButtonDisabled = !customPath.trim() || isSpawning || !isMachineOnline(machine!);

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
                                }]}>
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
                keyboardShouldPersistTaps="handled"
            >
                {/* Launch section */}
                {machine && (
                    <>
                        {!isMachineOnline(machine) && (
                            <ItemGroup>
                                <Item
                                    title={t('machine.offlineUnableToSpawn')}
                                    subtitle={t('machine.offlineHelp')}
                                    subtitleLines={0}
                                    showChevron={false}
                                />
                            </ItemGroup>
                        )}
                        <ItemGroup title={t('machine.launchNewSessionInDirectory')}>
                        <View style={{ opacity: isMachineOnline(machine) ? 1 : 0.5 }}>
                            <View style={styles.pathInputContainer}>
                                <View style={[styles.pathInput, { paddingVertical: 8 }]}>
                                    <MultiTextInput
                                        ref={inputRef}
                                        value={customPath}
                                        onChangeText={setCustomPath}
                                        placeholder={'Enter custom path'}
                                        maxHeight={76}
                                        paddingTop={8}
                                        paddingBottom={8}
                                        paddingRight={48}
                                    />
                                    <Pressable
                                        onPress={() => handleStartSession()}
                                        disabled={spawnButtonDisabled}
                                        style={[
                                            styles.inlineSendButton,
                                            spawnButtonDisabled ? styles.inlineSendInactive : styles.inlineSendActive
                                        ]}
                                    >
                                        <Ionicons
                                            name="play"
                                            size={16}
                                            color={spawnButtonDisabled ? theme.colors.textSecondary : theme.colors.button.primary.tint}
                                            style={{ marginLeft: 1 }}
                                        />
                                    </Pressable>
                                </View>
                            </View>
                            <View style={{ paddingTop: 4 }} />
                            {pathsToShow.map((path, index) => {
                                const display = formatPathRelativeToHome(path, machine.metadata?.homeDir);
                                const isSelected = customPath.trim() === display;
                                const isLast = index === pathsToShow.length - 1;
                                const hideDivider = isLast && pathsToShow.length <= 5;
                                return (
                                    <Item
                                        key={path}
                                        title={display}
                                        leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
                                        onPress={isMachineOnline(machine) ? () => {
                                            setCustomPath(display);
                                            setTimeout(() => inputRef.current?.focus(), 50);
                                        } : undefined}
                                        disabled={!isMachineOnline(machine)}
                                        selected={isSelected}
                                        showChevron={false}
                                        pressableStyle={isSelected ? { backgroundColor: theme.colors.surfaceSelected } : undefined}
                                        showDivider={!hideDivider}
                                    />
                                );
                            })}
                            {recentPaths.length > 5 && (
                                <Item
                                    title={showAllPaths ? t('machineLauncher.showLess') : t('machineLauncher.showAll', { count: recentPaths.length })}
                                    onPress={() => setShowAllPaths(!showAllPaths)}
                                    showChevron={false}
                                    showDivider={false}
                                    titleStyle={{
                                        textAlign: 'center',
                                        color: (theme as any).dark ? theme.colors.button.primary.tint : theme.colors.button.primary.background
                                    }}
                                />
                            )}
                        </View>
                        </ItemGroup>
                    </>
                )}

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

                {/* Previous Sessions (debug view) */}
                {previousSessions.length > 0 && (
                    <ItemGroup title={'Previous Sessions (up to 5 most recent)'}>
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
            </ItemList>
        </>
    );
}
