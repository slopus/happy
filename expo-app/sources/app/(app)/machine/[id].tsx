import React, { useState, useMemo, useCallback, useRef } from 'react';
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, Platform, Pressable, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupTitleWithAction } from '@/components/ui/lists/ItemGroupTitleWithAction';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines, useMachine, storage, useSetting, useSettingMutable, useSettings } from '@/sync/storage';
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import {
    machineSpawnNewSession,
    machineStopDaemon,
    machineUpdateMetadata,
} from '@/sync/ops';
import { Modal } from '@/modal';
import { formatPathRelativeToHome, getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { sync } from '@/sync/sync';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { MultiTextInput, type MultiTextInputHandle } from '@/components/MultiTextInput';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { useMachineCapabilitiesCache } from '@/hooks/useMachineCapabilitiesCache';
import { resolveTerminalSpawnOptions } from '@/sync/terminalSettings';
import { Switch } from '@/components/Switch';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { InstallableDepInstaller } from '@/components/machines/InstallableDepInstaller';
import { getInstallableDepRegistryEntries } from '@/capabilities/installableDepsRegistry';

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
    tmuxInputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    tmuxFieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
    },
    tmuxTextInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
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
    const isOnline = !!machine && isMachineOnline(machine);
    const metadata = machine?.metadata;

    const terminalUseTmux = useSetting('sessionUseTmux');
    const terminalTmuxSessionName = useSetting('sessionTmuxSessionName');
    const terminalTmuxIsolated = useSetting('sessionTmuxIsolated');
    const terminalTmuxTmpDir = useSetting('sessionTmuxTmpDir');
    const [terminalTmuxByMachineId, setTerminalTmuxByMachineId] = useSettingMutable('sessionTmuxByMachineId');
    const settings = useSettings();
    const experimentsEnabled = settings.experiments === true;

    const { state: detectedCapabilities, refresh: refreshDetectedCapabilities } = useMachineCapabilitiesCache({
        machineId: machineId ?? null,
        enabled: Boolean(machineId && isOnline),
        request: CAPABILITIES_REQUEST_MACHINE_DETAILS,
    });

    const tmuxOverride = machineId ? terminalTmuxByMachineId?.[machineId] : undefined;
    const tmuxOverrideEnabled = Boolean(tmuxOverride);

    const tmuxAvailable = React.useMemo(() => {
        const snapshot =
            detectedCapabilities.status === 'loaded'
                ? detectedCapabilities.snapshot
                : detectedCapabilities.status === 'loading'
                    ? detectedCapabilities.snapshot
                    : detectedCapabilities.status === 'error'
                        ? detectedCapabilities.snapshot
                        : undefined;
        const result = snapshot?.response.results['tool.tmux'];
        if (!result || !result.ok) return null;
        const data = result.data as any;
        return typeof data?.available === 'boolean' ? data.available : null;
    }, [detectedCapabilities]);

    const setTmuxOverrideEnabled = useCallback((enabled: boolean) => {
        if (!machineId) return;
        if (enabled) {
            setTerminalTmuxByMachineId({
                ...terminalTmuxByMachineId,
                [machineId]: {
                    useTmux: terminalUseTmux,
                    sessionName: terminalTmuxSessionName,
                    isolated: terminalTmuxIsolated,
                    tmpDir: terminalTmuxTmpDir,
                },
            });
            return;
        }

        const next = { ...terminalTmuxByMachineId };
        delete next[machineId];
        setTerminalTmuxByMachineId(next);
    }, [
        machineId,
        setTerminalTmuxByMachineId,
        terminalTmuxByMachineId,
        terminalUseTmux,
        terminalTmuxIsolated,
        terminalTmuxSessionName,
        terminalTmuxTmpDir,
    ]);

    const updateTmuxOverride = useCallback((patch: Partial<NonNullable<typeof tmuxOverride>>) => {
        if (!machineId || !tmuxOverride) return;
        setTerminalTmuxByMachineId({
            ...terminalTmuxByMachineId,
            [machineId]: {
                ...tmuxOverride,
                ...patch,
            },
        });
    }, [machineId, setTerminalTmuxByMachineId, terminalTmuxByMachineId, tmuxOverride]);

    const setTmuxOverrideUseTmux = useCallback((next: boolean) => {
        if (next && tmuxAvailable === false) {
            Modal.alert(t('common.error'), t('machine.tmux.notDetectedMessage'));
            return;
        }
        updateTmuxOverride({ useTmux: next });
    }, [tmuxAvailable, updateTmuxOverride]);

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

        if (machine.metadata?.daemonLastKnownStatus === 'shutting-down') {
            return 'stopped';
        }

        // Use machine online status as proxy for daemon status
        return isMachineOnline(machine) ? 'likely alive' : 'stopped';
    }, [machine]);

    const handleStopDaemon = async () => {
        // Show confirmation modal using alert with buttons
        Modal.alert(
            t('machine.stopDaemonConfirmTitle'),
            t('machine.stopDaemonConfirmBody'),
            [
                {
                    text: t('common.cancel'),
                    style: 'cancel'
                },
                {
                    text: t('machine.stopDaemon'),
                    style: 'destructive',
                    onPress: async () => {
                        setIsStoppingDaemon(true);
                        try {
                            const result = await machineStopDaemon(machineId!);
                            Modal.alert(t('machine.daemonStoppedTitle'), result.message);
                            // Refresh to get updated metadata
                            await sync.refreshMachines();
                        } catch (error) {
                            Modal.alert(t('common.error'), t('machine.stopDaemonFailed'));
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
        try {
            await sync.refreshMachines();
            refreshDetectedCapabilities();
        } finally {
            setIsRefreshing(false);
        }
    };

    const refreshCapabilities = useCallback(async () => {
        if (!machineId) return;
        // On direct loads/refreshes, machine encryption/socket may not be ready yet.
        // Refreshing machines first makes this much more reliable and avoids misclassifying
        // transient failures as “not supported / update CLI”.
        await sync.refreshMachines();
        refreshDetectedCapabilities();
    }, [machineId, refreshDetectedCapabilities]);

    const capabilitiesSnapshot = useMemo(() => {
        const snapshot =
            detectedCapabilities.status === 'loaded'
                ? detectedCapabilities.snapshot
                : detectedCapabilities.status === 'loading'
                    ? detectedCapabilities.snapshot
                    : detectedCapabilities.status === 'error'
                        ? detectedCapabilities.snapshot
                        : undefined;
        return snapshot ?? null;
    }, [detectedCapabilities]);

    const installableDepEntries = useMemo(() => {
        const entries = getInstallableDepRegistryEntries();
        const results = capabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const enabledFlag = (settings as any)[entry.enabledSettingKey] === true;
            const enabled = Boolean(machineId && experimentsEnabled && enabledFlag);
            const depStatus = entry.getDepStatus(results);
            const detectResult = entry.getDetectResult(results);
            return { entry, enabled, depStatus, detectResult };
        });
    }, [capabilitiesSnapshot, experimentsEnabled, machineId, settings]);

    React.useEffect(() => {
        if (!machineId) return;
        if (!isOnline) return;
        if (!experimentsEnabled) return;

        const results = capabilitiesSnapshot?.response.results;
        if (!results) return;

        const requests = installableDepEntries
            .filter((d) => d.enabled)
            .filter((d) => d.entry.shouldPrefetchRegistry({ requireExistingResult: true, result: d.detectResult, data: d.depStatus }))
            .flatMap((d) => d.entry.buildRegistryDetectRequest().requests ?? []);

        if (requests.length === 0) return;

        refreshDetectedCapabilities({
            request: { requests },
            timeoutMs: 12_000,
        });
    }, [capabilitiesSnapshot, experimentsEnabled, installableDepEntries, isOnline, machineId, refreshDetectedCapabilities]);

    const detectedClisTitle = useMemo(() => {
        const headerTextStyle = [
            Typography.default('regular'),
            {
                color: theme.colors.groupped.sectionTitle,
                fontSize: Platform.select({ ios: 13, default: 14 }),
                lineHeight: Platform.select({ ios: 18, default: 20 }),
                letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
                textTransform: 'uppercase' as const,
                fontWeight: Platform.select({ ios: 'normal', default: '500' }) as any,
            },
        ];

        const canRefresh = isOnline && detectedCapabilities.status !== 'loading';

        return (
            <ItemGroupTitleWithAction
                title={t('machine.detectedClis')}
                titleStyle={headerTextStyle as any}
                action={{
                    accessibilityLabel: t('common.refresh'),
                    iconName: 'refresh',
                    iconColor: isOnline ? theme.colors.textSecondary : theme.colors.divider,
                    disabled: !canRefresh,
                    loading: detectedCapabilities.status === 'loading',
                    onPress: () => void refreshCapabilities(),
                }}
            />
        );
    }, [
        detectedCapabilities.status,
        isOnline,
        machine,
        refreshCapabilities,
        theme.colors.divider,
        theme.colors.groupped.sectionTitle,
        theme.colors.textSecondary,
    ]);

    const handleRenameMachine = async () => {
        if (!machine || !machineId) return;

        const newDisplayName = await Modal.prompt(
            t('machine.renameTitle'),
            t('machine.renameDescription'),
            {
                defaultValue: machine.metadata?.displayName || '',
                placeholder: machine.metadata?.host || t('machine.renamePlaceholder'),
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
                
                Modal.alert(t('common.success'), t('machine.renamedSuccess'));
            } catch (error) {
                Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : t('machine.renameFailed')
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
            const terminal = resolveTerminalSpawnOptions({
                settings: storage.getState().settings,
                machineId,
            });
            const result = await machineSpawnNewSession({
                machineId: machineId!,
                directory: absolutePath,
                approvedNewDirectoryCreation,
                terminal,
            });
            switch (result.type) {
                case 'success':
                    // Dismiss machine picker & machine detail screen
                    router.back();
                    router.back();
                    if (result.sessionId) {
                        navigateToSession(result.sessionId);
                    } else {
                        Modal.alert(t('common.error'), t('newSession.failedToStart'));
                    }
                    break;
                case 'requestToApproveDirectoryCreation': {
                    const approved = await Modal.confirm(
                        t('newSession.directoryDoesNotExist'),
                        t('newSession.createDirectoryConfirm', { directory: result.directory }),
                        { cancelText: t('common.cancel'), confirmText: t('common.create') }
                    );
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
            let errorMessage = t('newSession.failedToStart');
            if (error instanceof Error && !error.message.includes('Failed to spawn session')) {
                errorMessage = error.message;
            }
            Modal.alert(t('common.error'), errorMessage);
        } finally {
            setIsSpawning(false);
        }
    };

    const pastUsedRelativePath = useCallback((session: Session) => {
        if (!session.metadata) return t('machine.unknownPath');
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }, []);

    const headerBackTitle = t('machine.back');

    const notFoundScreenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle: '',
            headerBackTitle,
        } as const;
    }, [headerBackTitle]);

    const machineName =
        machine?.metadata?.displayName ||
        machine?.metadata?.host ||
        t('machine.unknownMachine');
    const machineIsOnline = machine ? isMachineOnline(machine) : false;

    const headerTitle = React.useCallback(() => {
        if (!machine) return null;
        return (
            <View>
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
                        backgroundColor: machineIsOnline ? '#34C759' : '#999',
                        marginRight: 4
                    }} />
                    <Text style={[Typography.default(), {
                        fontSize: 12,
                        color: machineIsOnline ? '#34C759' : '#999'
                    }]}>
                        {machineIsOnline ? t('status.online') : t('status.offline')}
                    </Text>
                </View>
            </View>
        );
    }, [machineIsOnline, machine, machineName, theme.colors.header.tint]);

    const headerRight = React.useCallback(() => {
        if (!machine) return null;
        return (
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
                    size={20}
                    color={theme.colors.text}
                />
            </Pressable>
        );
    }, [handleRenameMachine, isRenamingMachine, machine, theme.colors.text]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle,
            headerRight,
            headerBackTitle,
        } as const;
    }, [headerBackTitle, headerRight, headerTitle]);

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={notFoundScreenOptions}
                />
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={[Typography.default(), { fontSize: 16, color: '#666' }]}>
                        {t('machine.notFound')}
                    </Text>
                </View>
            </>
        );
    }

    const spawnButtonDisabled = !customPath.trim() || isSpawning || !isMachineOnline(machine!);

    return (
        <>
            <Stack.Screen
                options={screenOptions}
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

                {/* Machine-specific tmux override */}
                {!!machineId && (
                    <ItemGroup title={t('profiles.tmux.title')}>
                        <Item
                            title={t('machine.tmux.overrideTitle')}
                            subtitle={tmuxOverrideEnabled ? t('machine.tmux.overrideEnabledSubtitle') : t('machine.tmux.overrideDisabledSubtitle')}
                            rightElement={<Switch value={tmuxOverrideEnabled} onValueChange={setTmuxOverrideEnabled} />}
                            showChevron={false}
                            onPress={() => setTmuxOverrideEnabled(!tmuxOverrideEnabled)}
                        />

                                {tmuxOverrideEnabled && tmuxOverride && (
                            <>
                                <Item
                                    title={t('profiles.tmux.spawnSessionsTitle')}
                                    subtitle={
                                        tmuxAvailable === false
                                            ? t('machine.tmux.notDetectedSubtitle')
                                            : (tmuxOverride.useTmux ? t('profiles.tmux.spawnSessionsEnabledSubtitle') : t('profiles.tmux.spawnSessionsDisabledSubtitle'))
                                    }
                                    rightElement={
                                        <Switch
                                            value={tmuxOverride.useTmux}
                                            onValueChange={setTmuxOverrideUseTmux}
                                            disabled={tmuxAvailable === false && !tmuxOverride.useTmux}
                                        />
                                    }
                                    showChevron={false}
                                    onPress={() => setTmuxOverrideUseTmux(!tmuxOverride.useTmux)}
                                />

                                {tmuxOverride.useTmux && (
                                    <>
                                        <View style={[styles.tmuxInputContainer, { paddingTop: 0 }]}>
                                            <Text style={styles.tmuxFieldLabel}>
                                                {t('profiles.tmuxSession')} ({t('common.optional')})
                                            </Text>
                                            <TextInput
                                                style={styles.tmuxTextInput}
                                                placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                                placeholderTextColor={theme.colors.input.placeholder}
                                                value={tmuxOverride.sessionName}
                                                onChangeText={(value) => updateTmuxOverride({ sessionName: value })}
                                            />
                                        </View>

                                        <Item
                                            title={t('profiles.tmux.isolatedServerTitle')}
                                            subtitle={tmuxOverride.isolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                                            rightElement={<Switch value={tmuxOverride.isolated} onValueChange={(next) => updateTmuxOverride({ isolated: next })} />}
                                            showChevron={false}
                                            onPress={() => updateTmuxOverride({ isolated: !tmuxOverride.isolated })}
                                        />

                                        {tmuxOverride.isolated && (
                                            <View style={[styles.tmuxInputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                                                <Text style={styles.tmuxFieldLabel}>
                                                    {t('profiles.tmuxTempDir')} ({t('common.optional')})
                                                </Text>
                                                <TextInput
                                                    style={styles.tmuxTextInput}
                                                    placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                                    placeholderTextColor={theme.colors.input.placeholder}
                                                    value={tmuxOverride.tmpDir ?? ''}
                                                    onChangeText={(value) => updateTmuxOverride({ tmpDir: value.trim().length > 0 ? value : null })}
                                                    autoCapitalize="none"
                                                    autoCorrect={false}
                                                />
                                            </View>
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </ItemGroup>
                )}

                {/* Detected CLIs */}
                <ItemGroup title={detectedClisTitle}>
                    <DetectedClisList state={detectedCapabilities} />
                </ItemGroup>

                {installableDepEntries.map(({ entry, enabled, depStatus }) => (
                    <InstallableDepInstaller
                        key={entry.key}
                        machineId={machineId ?? ''}
                        enabled={enabled}
                        groupTitle={`${t(entry.groupTitleKey)}${entry.experimental ? ' (experimental)' : ''}`}
                        depId={entry.depId}
                        depTitle={entry.depTitle}
                        depIconName={entry.depIconName as any}
                        depStatus={depStatus}
                        capabilitiesStatus={detectedCapabilities.status}
                        installSpecSettingKey={entry.installSpecSettingKey}
                        installSpecTitle={entry.installSpecTitle}
                        installSpecDescription={entry.installSpecDescription}
                        installLabels={{
                            install: t(entry.installLabels.installKey),
                            update: t(entry.installLabels.updateKey),
                            reinstall: t(entry.installLabels.reinstallKey),
                        }}
                        installModal={{
                            installTitle: t(entry.installModal.installTitleKey),
                            updateTitle: t(entry.installModal.updateTitleKey),
                            reinstallTitle: t(entry.installModal.reinstallTitleKey),
                            description: t(entry.installModal.descriptionKey),
                        }}
                        refreshStatus={() => void refreshCapabilities()}
                        refreshRegistry={() => {
                            if (!machineId) return;
                            refreshDetectedCapabilities({ request: entry.buildRegistryDetectRequest(), timeoutMs: 12_000 });
                        }}
                    />
                ))}

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
