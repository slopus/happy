import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Platform, Pressable, TextInput } from 'react-native';
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
import { formatPathRelativeToHome, getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { sync } from '@/sync/sync';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { machineSpawnNewSession } from '@/sync/ops';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { MultiTextInput, type MultiTextInputHandle } from '@/components/MultiTextInput';
import { getTerminalCollectionState } from '@/components/terminal/terminalUiState';
import {
    terminalApprove,
    terminalClose,
    terminalCreate,
    terminalGetPolicy,
    terminalList,
    terminalSetPolicy,
    type RemoteTerminal,
    type TerminalApprovalPolicy,
} from '@/sync/terminalClient';

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
        backgroundColor: Platform.select({
            web: theme.colors.input?.background ?? theme.colors.groupped.background,
            default: theme.colors.glass.backgroundSubtle,
        }),
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
    tabShell: {
        flexDirection: 'row',
        marginHorizontal: 8,
        marginVertical: 8,
        padding: 3,
        borderRadius: 11,
        backgroundColor: theme.colors.surfaceHigh,
    },
    tab: {
        flex: 1,
        minHeight: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    tabSelected: {
        backgroundColor: theme.colors.groupped.background,
    },
    tabPressed: {
        opacity: 0.72,
        transform: [{ scale: 0.98 }],
    },
    terminalRowActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    terminalStatus: {
        ...Typography.default(),
        fontSize: 14,
    },
    terminalMenuButton: {
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: 'center',
        justifyContent: 'center',
    },
    terminalMenuPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
        transform: [{ scale: 0.96 }],
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
    const [isDeletingMachine, setIsDeletingMachine] = useState(false);
    const [customPath, setCustomPath] = useState('');
    const [isSpawning, setIsSpawning] = useState(false);
    const inputRef = useRef<MultiTextInputHandle>(null);
    const [showAllPaths, setShowAllPaths] = useState(false);
    const [activeTab, setActiveTab] = useState<'sessions' | 'terminals'>('sessions');
    const [terminals, setTerminals] = useState<RemoteTerminal[]>([]);
    const [terminalsLoading, setTerminalsLoading] = useState(false);
    const [isCreatingTerminal, setIsCreatingTerminal] = useState(false);
    const [approvalPolicy, setApprovalPolicy] = useState<TerminalApprovalPolicy>('per-session');
    const [terminalsDisabled, setTerminalsDisabled] = useState(false);
    const [terminalLoadError, setTerminalLoadError] = useState<string | null>(null);
    const [closingTerminalId, setClosingTerminalId] = useState<string | null>(null);
    const [isUpdatingApprovalPolicy, setIsUpdatingApprovalPolicy] = useState(false);
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

    const loadTerminals = useCallback(async () => {
        if (!machineId) return;
        setTerminalsLoading(true);
        setTerminalsDisabled(false);
        setTerminalLoadError(null);
        try {
            const [list, policyResult] = await Promise.all([
                terminalList(machineId),
                terminalGetPolicy(machineId),
            ]);
            setTerminals(list);
            setApprovalPolicy(policyResult.policy);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to load terminals';
            if (message.includes('RPC method not available')) {
                // The daemon runs with HAPPY_TERMINAL_ENABLED unset/off.
                setTerminalsDisabled(true);
                setTerminals([]);
            } else {
                setTerminalLoadError(message);
                setTerminals([]);
            }
        } finally {
            setTerminalsLoading(false);
        }
    }, [machineId]);

    useEffect(() => {
        if (activeTab === 'terminals' && machineId && isMachineOnline(machine!)) {
            void loadTerminals();
        }
    }, [activeTab, machineId, loadTerminals, machine]);

    const handleCreateTerminal = async () => {
        if (!machine || !machineId) return;
        try {
            const name = await Modal.prompt(
                'New Terminal',
                'Give this terminal a name (optional).',
                { defaultValue: '', placeholder: 'e.g. dev', cancelText: t('common.cancel'), confirmText: t('common.create') },
            );
            if (name === null) return;

            const cwdInput = await Modal.prompt(
                'Working Directory',
                'Choose where this persistent shell should start.',
                {
                    defaultValue: customPath.trim() || '~',
                    placeholder: '~/project',
                    cancelText: t('common.cancel'),
                    confirmText: t('common.continue'),
                },
            );
            if (cwdInput === null) return;

            const requestedCwd = cwdInput.trim() || '~';
            const cwd = resolveAbsolutePath(requestedCwd, machine.metadata?.homeDir);
            setCustomPath(requestedCwd);
            setIsCreatingTerminal(true);
            const result = await terminalCreate(machineId, {
                name: name.trim() || undefined,
                cwd,
                cols: 80,
                rows: 24,
            });

            switch (result.type) {
                case 'success':
                    router.push({
                        pathname: '/remote-terminal/[id]',
                        params: {
                            id: result.terminalId,
                            machineId,
                            name: name.trim() || 'Terminal',
                            cwd,
                        },
                    });
                    break;
                case 'awaiting-approval': {
                    const machineName = machine.metadata?.displayName || machine.metadata?.host || 'this machine';
                    const approved = await Modal.confirm(
                        'Open Remote Terminal?',
                        `This opens a persistent shell on ${machineName} in ${cwd} (${result.terminalId}).`,
                        { cancelText: t('common.cancel'), confirmText: 'Approve' },
                    );
                    if (approved) {
                        const approvedResult = await terminalApprove(machineId, result.approvalId);
                        if (approvedResult.type === 'success') {
                            router.push({
                                pathname: '/remote-terminal/[id]',
                                params: {
                                    id: approvedResult.terminalId,
                                    machineId,
                                    name: name.trim() || 'Terminal',
                                    cwd,
                                },
                            });
                        } else if (approvedResult.type === 'error') {
                            Modal.alert(t('common.error'), approvedResult.errorMessage);
                        }
                    } else {
                        await terminalClose(machineId, result.terminalId).catch(() => undefined);
                        await loadTerminals();
                    }
                    break;
                }
                case 'error':
                    Modal.alert(t('common.error'), result.errorMessage);
                    break;
            }
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : 'Failed to create terminal',
            );
        } finally {
            setIsCreatingTerminal(false);
        }
    };

    const handleCloseTerminal = async (terminal: RemoteTerminal) => {
        if (!machineId || closingTerminalId) return;
        const confirmed = await Modal.confirm(
            'Close Terminal?',
            `This kills the shell '${terminal.name}' on ${terminal.cwd}.`,
            { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        setClosingTerminalId(terminal.terminalId);
        try {
            await terminalClose(machineId, terminal.terminalId);
            await loadTerminals();
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to close terminal');
        } finally {
            setClosingTerminalId(null);
        }
    };

    const applyApprovalPolicy = async (policy: TerminalApprovalPolicy) => {
        if (!machineId || isUpdatingApprovalPolicy || policy === approvalPolicy) return;
        if (policy === 'none') {
            const confirmed = await Modal.confirm(
                'Disable terminal approval?',
                'New remote shells will open without desktop approval on this machine.',
                { cancelText: t('common.cancel'), confirmText: 'Disable Approval', destructive: true },
            );
            if (!confirmed) return;
        }

        setIsUpdatingApprovalPolicy(true);
        try {
            await terminalSetPolicy(machineId, policy);
            setApprovalPolicy(policy);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to update policy');
        } finally {
            setIsUpdatingApprovalPolicy(false);
        }
    };

    const handleChangeApprovalPolicy = () => {
        Modal.alert(
            'Terminal Approval',
            'Choose when opening a remote shell on this machine requires approval.',
            [
                { text: `${approvalPolicy === 'per-session' ? '✓ ' : ''}Approve every session`, onPress: () => void applyApprovalPolicy('per-session') },
                { text: `${approvalPolicy === 'once-per-machine' ? '✓ ' : ''}Approve once per machine`, onPress: () => void applyApprovalPolicy('once-per-machine') },
                { text: `${approvalPolicy === 'none' ? '✓ ' : ''}No approval`, onPress: () => void applyApprovalPolicy('none') },
                { text: t('common.cancel'), style: 'cancel', onPress: () => undefined },
            ],
        );
    };

    const openTerminal = (terminal: RemoteTerminal) => {
        router.push({
            pathname: '/remote-terminal/[id]',
            params: {
                id: terminal.terminalId,
                machineId: machineId!,
                name: terminal.name,
                cwd: terminal.cwd,
            },
        });
    };

    const handleTerminalMenu = (terminal: RemoteTerminal) => {
        Modal.alert(
            terminal.name,
            `${formatPathRelativeToHome(terminal.cwd, machine?.metadata?.homeDir)} · ${terminalStatusLabel(terminal.status)}`,
            [
                { text: 'Open', onPress: () => openTerminal(terminal) },
                { text: 'Close Terminal', style: 'destructive', onPress: () => void handleCloseTerminal(terminal) },
                { text: t('common.cancel'), style: 'cancel', onPress: () => undefined },
            ],
        );
    };

    const terminalStatusLabel = (status: RemoteTerminal['status']): string => {
        switch (status) {
            case 'running': return 'Running';
            case 'pending': return 'Waiting for approval';
            case 'exited': return 'Exited';
            case 'closed': return 'Closed';
        }
    };

    const terminalStatusColor = (status: RemoteTerminal['status'], fallback: string): string => {
        switch (status) {
            case 'running': return '#34C759';
            case 'pending': return '#FF9F0A';
            case 'exited':
            case 'closed':
                return fallback;
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
    const machineOnline = isMachineOnline(machine);
    const terminalCollectionState = getTerminalCollectionState({
        online: machineOnline,
        loading: terminalsLoading,
        disabled: terminalsDisabled,
        error: terminalLoadError,
        count: terminals.length,
    });

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
                {/* Sessions / Terminals tabs */}
                <ItemGroup>
                    <View style={styles.tabShell}>
                        {(['sessions', 'terminals'] as const).map((tab) => (
                            <Pressable
                                key={tab}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: activeTab === tab }}
                                onPress={() => setActiveTab(tab)}
                                style={({ pressed }) => [
                                    styles.tab,
                                    activeTab === tab ? styles.tabSelected : null,
                                    pressed ? styles.tabPressed : null,
                                ]}
                            >
                                <Text
                                    style={[
                                        Typography.default(activeTab === tab ? 'semiBold' : undefined),
                                        {
                                            color: activeTab === tab
                                                ? theme.colors.button.primary.background
                                                : theme.colors.textSecondary,
                                        },
                                    ]}
                                >
                                    {tab === 'sessions' ? 'Sessions' : 'Terminals'}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                </ItemGroup>

                {/* Launch section */}
                {activeTab === 'sessions' && machine && (
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
                                        pressableStyle={isSelected ? {
                                            backgroundColor: Platform.select({
                                                web: theme.colors.surfaceSelected,
                                                default: theme.colors.glass.backgroundSubtle,
                                            }),
                                        } : undefined}
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

                {/* Remote terminals */}
                {activeTab === 'terminals' && (
                    <>
                        <ItemGroup title="Remote Terminals">
                            {terminalCollectionState !== 'offline' && terminalCollectionState !== 'disabled' && (
                                <Item
                                    title="New Terminal"
                                    subtitle="Choose a name and working directory"
                                    onPress={handleCreateTerminal}
                                    disabled={isCreatingTerminal}
                                    rightElement={isCreatingTerminal
                                        ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                        : <Ionicons name="add-circle" size={24} color={theme.colors.button.primary.background} />}
                                />
                            )}
                            {terminalCollectionState === 'offline' && (
                                <Item
                                    title="Machine is offline"
                                    subtitle="Reconnect the machine to view or create remote terminals"
                                    showChevron={false}
                                />
                            )}
                            {terminalCollectionState === 'loading' && (
                                <Item title="Loading terminals…" showChevron={false} loading />
                            )}
                            {terminalCollectionState === 'disabled' && (
                                <Item
                                    title="Terminals are disabled on this machine"
                                    subtitle="Set HAPPY_TERMINAL_ENABLED=1 when starting the daemon to enable remote shells"
                                    showChevron={false}
                                />
                            )}
                            {terminalCollectionState === 'error' && (
                                <Item
                                    title="Unable to load terminals"
                                    subtitle={terminalLoadError || 'Try again when the machine is available'}
                                    onPress={() => void loadTerminals()}
                                    rightElement={<Ionicons name="refresh" size={21} color={theme.colors.button.primary.background} />}
                                />
                            )}
                            {terminalCollectionState === 'empty' && (
                                <Item
                                    title="No terminals yet"
                                    subtitle="Create one to keep a shell alive on this machine"
                                    showChevron={false}
                                />
                            )}
                            {terminalCollectionState === 'ready' && terminals.map((terminal) => (
                                <Item
                                    key={terminal.terminalId}
                                    title={terminal.name}
                                    subtitle={formatPathRelativeToHome(terminal.cwd, machine?.metadata?.homeDir)}
                                    onPress={() => openTerminal(terminal)}
                                    onLongPress={() => void handleCloseTerminal(terminal)}
                                    rightElement={(
                                        <View style={styles.terminalRowActions}>
                                            {closingTerminalId === terminal.terminalId ? (
                                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                            ) : (
                                                <Text style={[
                                                    styles.terminalStatus,
                                                    { color: terminalStatusColor(terminal.status, theme.colors.textSecondary) },
                                                ]}>
                                                    {terminalStatusLabel(terminal.status)}
                                                </Text>
                                            )}
                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={`More actions for ${terminal.name}`}
                                                hitSlop={6}
                                                onPress={(event) => {
                                                    event.stopPropagation();
                                                    handleTerminalMenu(terminal);
                                                }}
                                                style={({ pressed }) => [
                                                    styles.terminalMenuButton,
                                                    pressed ? styles.terminalMenuPressed : null,
                                                ]}
                                            >
                                                <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.textSecondary} />
                                            </Pressable>
                                        </View>
                                    )}
                                />
                            ))}
                        </ItemGroup>
                        <ItemGroup title="Remote Terminal Settings">
                            <Item
                                title="Approval policy"
                                subtitle="When opening a shell from this app requires desktop approval"
                                detail={approvalPolicy === 'none'
                                    ? 'No approval'
                                    : approvalPolicy === 'once-per-machine'
                                        ? 'Once per machine'
                                        : 'Every session'}
                                onPress={handleChangeApprovalPolicy}
                                disabled={isUpdatingApprovalPolicy}
                                loading={isUpdatingApprovalPolicy}
                                showChevron={!isUpdatingApprovalPolicy}
                            />
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
