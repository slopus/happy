import React, { useCallback } from 'react';
import { View, Text, Animated, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Avatar } from '@/components/Avatar';
import { useSession, useIsDataReady } from '@/sync/storage';
import { getSessionName, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId } from '@/utils/sessionUtils';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { sessionKill, sessionDelete, machineForkClaudeSession, machineSpawnNewSession, sessionUpdateSummary } from '@/sync/ops';
import { isWorktreeSession, pushWorktreeBranch, mergeWorktreeBranch, createWorktreePR, cleanupWorktree } from '@/utils/worktreeOps';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import { CodeView } from '@/components/CodeView';
import { Session } from '@/sync/storageTypes';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';

// Animated status dot component
function StatusDot({ color, isPulsing, size = 8 }: { color: string; isPulsing?: boolean; size?: number }) {
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (isPulsing) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 0.3,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isPulsing, pulseAnim]);

    return (
        <Animated.View
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                opacity: pulseAnim,
                marginRight: 4,
            }}
        />
    );
}

function SessionInfoContent({ session }: { session: Session }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const devModeEnabled = __DEV__;
    const sessionName = getSessionName(session);
    const sessionStatus = useSessionStatus(session);
    
    // Check if CLI version is outdated
    const isCliOutdated = session.metadata?.version && !isVersionSupported(session.metadata.version, MINIMUM_CLI_VERSION);

    const handleCopySessionId = useCallback(async () => {
        if (!session) return;
        try {
            await Clipboard.setStringAsync(session.id);
            Modal.alert(t('common.success'), t('sessionInfo.happySessionIdCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopySessionId'));
        }
    }, [session]);

    const handleCopyMetadata = useCallback(async () => {
        if (!session?.metadata) return;
        try {
            await Clipboard.setStringAsync(JSON.stringify(session.metadata, null, 2));
            Modal.alert(t('common.success'), t('sessionInfo.metadataCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        }
    }, [session]);

    // Use HappyAction for archiving - it handles errors automatically
    const [archivingSession, performArchive] = useHappyAction(async () => {
        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
        }
        // Success - navigate back
        router.back();
        router.back();
    });

    const handleArchiveSession = useCallback(() => {
        if (isWorktreeSession(session.metadata) && session.metadata?.machineId && session.metadata?.worktreeBasePath && session.metadata?.worktreeBranchName) {
            const machineId = session.metadata.machineId;
            const basePath = session.metadata.worktreeBasePath;
            const branchName = session.metadata.worktreeBranchName;
            Modal.alert(
                t('sessionInfo.archiveSession'),
                t('sessionInfo.worktree.archiveWorktreeConfirm'),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('sessionInfo.worktree.archiveAndCleanup'),
                        style: 'destructive',
                        onPress: async () => {
                            // Clean up worktree first (while component is still mounted),
                            // then archive (which navigates away)
                            try {
                                await cleanupWorktree(machineId, basePath, branchName);
                            } catch (e) {
                                console.warn('Worktree cleanup failed:', e);
                            }
                            await performArchive();
                        }
                    },
                    {
                        text: t('sessionInfo.worktree.archiveKeepWorktree'),
                        onPress: performArchive
                    }
                ]
            );
        } else {
            Modal.alert(
                t('sessionInfo.archiveSession'),
                t('sessionInfo.archiveSessionConfirm'),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('sessionInfo.archiveSession'),
                        style: 'destructive',
                        onPress: performArchive
                    }
                ]
            );
        }
    }, [performArchive, session.metadata]);

    // Use HappyAction for deletion - it handles errors automatically
    const [deletingSession, performDelete] = useHappyAction(async () => {
        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToDeleteSession'), false);
        }
        // Success - no alert needed, UI will update to show deleted state
    });

    const handleDeleteSession = useCallback(() => {
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete
                }
            ]
        );
    }, [performDelete]);

    const [forkingSession, setForkingSession] = React.useState(false);
    const handleForkSession = useCallback(async () => {
        if (forkingSession) return;
        const claudeSessionId = session.metadata?.claudeSessionId;
        const machineId = session.metadata?.machineId;
        const directory = session.metadata?.path;
        if (!claudeSessionId || !directory || !machineId) return;

        const isOnline = session.active;
        const confirmTitle = isOnline ? t('sessionHistory.copyConfirmTitle') : t('sessionHistory.resumeConfirmTitle');
        const confirmMessage = isOnline ? t('sessionHistory.copyConfirmMessage') : t('sessionHistory.resumeConfirmMessage');
        const confirmed = await Modal.confirm(confirmTitle, confirmMessage, {
            confirmText: t('common.continue'),
            cancelText: t('common.cancel'),
        });
        if (!confirmed) return;

        setForkingSession(true);
        try {
            const originalTitle = session.metadata?.summary?.text || getSessionName(session);
            let sessionTitle = originalTitle;
            if (isOnline) {
                const now = new Date();
                const timeSuffix = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
                sessionTitle = `${originalTitle}_${timeSuffix}`;
            }
            const forkResult = await machineForkClaudeSession(machineId, claudeSessionId);
            if (!forkResult.success || !forkResult.newSessionId) {
                Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                return;
            }
            const result = await machineSpawnNewSession({
                machineId,
                directory,
                approvedNewDirectoryCreation: false,
                agent: 'claude',
                resumeSessionId: forkResult.newSessionId,
                sessionTitle,
                skipForkSession: true,
            });
            if (result.type === 'requestToApproveDirectoryCreation') {
                Modal.alert(t('common.error'), t('claudeHistory.directoryNotFound'));
                return;
            }
            if (result.type === 'error') {
                Modal.alert(t('common.error'), result.errorMessage || t('claudeHistory.resumeFailed'));
                return;
            }
            if (result.type === 'success') {
                await sync.refreshSessions();
                router.push(`/session/${result.sessionId}`);
            }
        } catch (error) {
            console.error('Failed to fork session', error);
            Modal.alert(t('common.error'), t('claudeHistory.resumeFailed'));
        } finally {
            setForkingSession(false);
        }
    }, [session, forkingSession, router]);

    const formatDate = useCallback((timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    }, []);

    const handleRenameSession = useCallback(async () => {
        if (!session.metadata) return;

        const result = await Modal.promptWithCheckbox(
            t('sessionInfo.renameSession'),
            t('sessionInfo.renameSessionHint'),
            {
                defaultValue: session.metadata.summary?.text || '',
                placeholder: getSessionName(session),
                cancelText: t('common.cancel'),
                confirmText: t('common.rename'),
                checkbox: {
                    label: t('sessionInfo.pinSessionTitle'),
                    defaultValue: session.metadata.summaryPinned ?? false
                }
            }
        );

        if (result !== null) {
            const trimmed = result.value.trim();
            if (!trimmed) return;
            try {
                await sessionUpdateSummary(
                    session.id,
                    session.metadata,
                    trimmed,
                    session.metadataVersion,
                    result.checked
                );
            } catch (error) {
                Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : t('sessionInfo.failedToRenameSession')
                );
            }
        }
    }, [session]);

    const handleCopyUpdateCommand = useCallback(async () => {
        const updateCommand = 'npm install -g happy-code-cli@latest';
        try {
            await Clipboard.setStringAsync(updateCommand);
            Modal.alert(t('common.success'), updateCommand);
        } catch (error) {
            Modal.alert(t('common.error'), t('common.error'));
        }
    }, []);

    // Worktree action handlers
    const isWorktree = isWorktreeSession(session.metadata);
    const worktreeMachineId = session.metadata?.machineId;
    const worktreeBasePath = session.metadata?.worktreeBasePath;
    const worktreeBranch = session.metadata?.worktreeBranchName;
    const worktreePath = session.metadata?.path;

    const [pushingBranch, handlePushBranch] = useHappyAction(async () => {
        if (!worktreeMachineId || !worktreeBranch || !worktreePath) return;
        const confirmed = await Modal.confirm(
            t('sessionInfo.worktree.pushBranch'),
            t('sessionInfo.worktree.pushConfirm', { branch: worktreeBranch })
        );
        if (!confirmed) return;
        const result = await pushWorktreeBranch(worktreeMachineId, worktreePath, worktreeBranch);
        if (!result.success) {
            throw new HappyError(result.error || t('sessionInfo.worktree.pushFailed'), false);
        }
        Modal.alert(t('common.success'), t('sessionInfo.worktree.pushSuccess', { branch: worktreeBranch }));
    });

    const [creatingPR, handleCreatePR] = useHappyAction(async () => {
        if (!worktreeMachineId || !worktreeBranch || !worktreePath) return;
        const sessionTitle = session.metadata?.summary?.text || getSessionName(session);
        const confirmed = await Modal.confirm(
            t('sessionInfo.worktree.createPR'),
            t('sessionInfo.worktree.createPRConfirm', { branch: worktreeBranch })
        );
        if (!confirmed) return;
        const result = await createWorktreePR(worktreeMachineId, worktreePath, worktreeBranch, sessionTitle);
        if (!result.success) {
            if (result.error === 'gh_not_installed') {
                throw new HappyError(t('sessionInfo.worktree.ghNotInstalled'), false);
            }
            throw new HappyError(result.error || t('sessionInfo.worktree.createPRFailed'), false);
        }
        Modal.alert(t('common.success'), t('sessionInfo.worktree.createPRSuccess', { url: result.prUrl || '' }));
    });

    const [mergingBranch, handleMergeBranch] = useHappyAction(async () => {
        if (!worktreeMachineId || !worktreeBranch || !worktreeBasePath) return;
        const confirmed = await Modal.confirm(
            t('sessionInfo.worktree.mergeBranch'),
            t('sessionInfo.worktree.mergeConfirm', { branch: worktreeBranch })
        );
        if (!confirmed) return;
        const result = await mergeWorktreeBranch(worktreeMachineId, worktreeBasePath, worktreeBranch);
        if (!result.success) {
            if (result.hasConflicts) {
                throw new HappyError(t('sessionInfo.worktree.mergeConflicts'), false);
            }
            throw new HappyError(result.error || t('sessionInfo.worktree.mergeFailed'), false);
        }
        Modal.alert(t('common.success'), t('sessionInfo.worktree.mergeSuccess'));
    });

    const [cleaningUp, handleCleanupWorktree] = useHappyAction(async () => {
        if (!worktreeMachineId || !worktreeBranch || !worktreeBasePath) return;
        const confirmed = await Modal.confirm(
            t('sessionInfo.worktree.cleanup'),
            t('sessionInfo.worktree.cleanupConfirm')
        );
        if (!confirmed) return;
        const result = await cleanupWorktree(worktreeMachineId, worktreeBasePath, worktreeBranch);
        if (!result.success) {
            throw new HappyError(result.error || t('sessionInfo.worktree.cleanupFailed'), false);
        }
        Modal.alert(t('common.success'), t('sessionInfo.worktree.cleanupSuccess'));
    });

    return (
        <>
            <ItemList>
                {/* Session Header */}
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginBottom: 8, borderRadius: 12, marginHorizontal: 16, marginTop: 16 }}>
                        <Avatar id={getSessionAvatarId(session)} size={80} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
                        <Pressable onPress={handleRenameSession} style={{ marginTop: 12, paddingHorizontal: 16 }}>
                            <Text style={{
                                fontSize: 20,
                                fontWeight: '600',
                                textAlign: 'center',
                                color: theme.colors.text,
                                ...Typography.default('semiBold')
                            }}>
                                {sessionName}
                            </Text>
                        </Pressable>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                            <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} size={10} />
                            <Text style={{
                                fontSize: 15,
                                color: sessionStatus.statusColor,
                                fontWeight: '500',
                                ...Typography.default()
                            }}>
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    </View>
                </View>

                {/* CLI Version Warning */}
                {isCliOutdated && (
                    <ItemGroup>
                        <Item
                            title={t('sessionInfo.cliVersionOutdated')}
                            subtitle={t('sessionInfo.updateCliInstructions')}
                            icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                            onPress={handleCopyUpdateCommand}
                        />
                    </ItemGroup>
                )}

                {/* Repository */}
                {session.metadata?.path && sessionStatus.isConnected && (
                    <ItemGroup>
                        <Item
                            title={t('repository.code')}
                            icon={<Ionicons name="code-slash-outline" size={29} color="#007AFF" />}
                            onPress={() => router.push(`/session/${session.id}/browser`)}
                        />
                        <Item
                            title={t('repository.commits')}
                            icon={<Ionicons name="git-commit-outline" size={29} color="#007AFF" />}
                            onPress={() => router.push(`/session/${session.id}/commits`)}
                        />
                    </ItemGroup>
                )}

                {/* Session Details */}
                <ItemGroup>
                    <Item
                        title={t('sessionInfo.happySessionId')}
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        icon={<Ionicons name="finger-print-outline" size={29} color="#007AFF" />}
                        onPress={handleCopySessionId}
                    />
                    {session.metadata?.claudeSessionId && (
                        <Item
                            title={t('sessionInfo.claudeCodeSessionId')}
                            subtitle={`${session.metadata.claudeSessionId.substring(0, 8)}...${session.metadata.claudeSessionId.substring(session.metadata.claudeSessionId.length - 8)}`}
                            icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                            onPress={async () => {
                                try {
                                    await Clipboard.setStringAsync(session.metadata!.claudeSessionId!);
                                    Modal.alert(t('common.success'), t('sessionInfo.claudeCodeSessionIdCopied'));
                                } catch (error) {
                                    Modal.alert(t('common.error'), t('sessionInfo.failedToCopyClaudeCodeSessionId'));
                                }
                            }}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.connectionStatus')}
                        detail={sessionStatus.isConnected ? t('status.online') : t('status.offline')}
                        icon={<Ionicons name="pulse-outline" size={29} color={sessionStatus.isConnected ? "#34C759" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.created')}
                        subtitle={formatDate(session.createdAt)}
                        icon={<Ionicons name="calendar-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.lastUpdated')}
                        subtitle={formatDate(session.updatedAt)}
                        icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.sequence')}
                        detail={session.seq.toString()}
                        icon={<Ionicons name="git-commit-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Quick Actions */}
                <ItemGroup title={t('sessionInfo.quickActions')}>
                    {session.metadata?.machineId && (
                        <Item
                            title={t('sessionInfo.viewMachine')}
                            subtitle={t('sessionInfo.viewMachineSubtitle')}
                            icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                            onPress={() => router.push(`/machine/${session.metadata?.machineId}`)}
                        />
                    )}
                    {session.metadata?.claudeSessionId && session.metadata?.machineId && session.metadata?.path && (
                        <Item
                            title={session.active ? t('sessionInfo.copySession') : t('sessionInfo.resumeSession')}
                            subtitle={session.active ? t('sessionInfo.copySessionSubtitle') : t('sessionInfo.resumeSessionSubtitle')}
                            icon={<Ionicons name={session.active ? "copy-outline" : "play-circle-outline"} size={29} color="#34C759" />}
                            onPress={handleForkSession}
                            disabled={forkingSession}
                            loading={forkingSession}
                            showChevron={!forkingSession}
                        />
                    )}
                    {sessionStatus.isConnected && (
                        <Item
                            title={t('sessionInfo.archiveSession')}
                            subtitle={t('sessionInfo.archiveSessionSubtitle')}
                            icon={<Ionicons name="archive-outline" size={29} color="#FF3B30" />}
                            onPress={handleArchiveSession}
                        />
                    )}
                    {!sessionStatus.isConnected && !session.active && (
                        <Item
                            title={t('sessionInfo.deleteSession')}
                            subtitle={t('sessionInfo.deleteSessionSubtitle')}
                            icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                            onPress={handleDeleteSession}
                        />
                    )}
                </ItemGroup>

                {/* Worktree Info & Actions */}
                {isWorktree && worktreeBranch && (
                    <ItemGroup title={t('sessionInfo.worktree.title')}>
                        <Item
                            title={t('sessionInfo.worktree.branch')}
                            subtitle={worktreeBranch}
                            icon={<Ionicons name="git-branch-outline" size={29} color="#34C759" />}
                            showChevron={false}
                        />
                        {worktreeBasePath && (
                            <Item
                                title={t('sessionInfo.worktree.basePath')}
                                subtitle={formatPathRelativeToHome(worktreeBasePath, session.metadata?.homeDir)}
                                icon={<Ionicons name="folder-open-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}
                {isWorktree && worktreeMachineId && worktreeBranch && (
                    <ItemGroup title={t('sessionInfo.worktree.actions')}>
                        <Item
                            title={t('sessionInfo.worktree.pushBranch')}
                            subtitle={t('sessionInfo.worktree.pushBranchSubtitle')}
                            icon={<Ionicons name="cloud-upload-outline" size={29} color="#007AFF" />}
                            onPress={handlePushBranch}
                            loading={pushingBranch}
                            disabled={pushingBranch}
                        />
                        <Item
                            title={t('sessionInfo.worktree.createPR')}
                            subtitle={t('sessionInfo.worktree.createPRSubtitle')}
                            icon={<Ionicons name="git-pull-request-outline" size={29} color="#34C759" />}
                            onPress={handleCreatePR}
                            loading={creatingPR}
                            disabled={creatingPR}
                        />
                        <Item
                            title={t('sessionInfo.worktree.mergeBranch')}
                            subtitle={t('sessionInfo.worktree.mergeBranchSubtitle')}
                            icon={<Ionicons name="git-merge-outline" size={29} color="#FF9500" />}
                            onPress={handleMergeBranch}
                            loading={mergingBranch}
                            disabled={mergingBranch}
                        />
                        <Item
                            title={t('sessionInfo.worktree.cleanup')}
                            subtitle={t('sessionInfo.worktree.cleanupSubtitle')}
                            icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                            onPress={handleCleanupWorktree}
                            loading={cleaningUp}
                            disabled={cleaningUp}
                        />
                    </ItemGroup>
                )}

                {/* Metadata */}
                {session.metadata && (
                    <ItemGroup title={t('sessionInfo.metadata')}>
                        <Item
                            title={t('sessionInfo.host')}
                            subtitle={session.metadata.host}
                            icon={<Ionicons name="desktop-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        <Item
                            title={t('sessionInfo.path')}
                            subtitle={formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)}
                            icon={<Ionicons name="folder-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        {session.metadata.version && (
                            <Item
                                title={t('sessionInfo.cliVersion')}
                                subtitle={session.metadata.version}
                                detail={isCliOutdated ? '⚠️' : undefined}
                                icon={<Ionicons name="git-branch-outline" size={29} color={isCliOutdated ? "#FF9500" : "#5856D6"} />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.os && (
                            <Item
                                title={t('sessionInfo.operatingSystem')}
                                subtitle={formatOSPlatform(session.metadata.os)}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.aiProvider')}
                            subtitle={(() => {
                                const flavor = session.metadata.flavor || 'claude';
                                if (flavor === 'claude') return 'Claude';
                                if (flavor === 'gpt' || flavor === 'openai') return 'Codex';
                                if (flavor === 'gemini') return 'Gemini';
                                return flavor;
                            })()}
                            icon={<Ionicons name="sparkles-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        {session.metadata.hostPid && (
                            <Item
                                title={t('sessionInfo.processId')}
                                subtitle={session.metadata.hostPid.toString()}
                                icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.happyHomeDir && (
                            <Item
                                title={t('sessionInfo.happyHome')}
                                subtitle={formatPathRelativeToHome(session.metadata.happyHomeDir, session.metadata.homeDir)}
                                icon={<Ionicons name="home-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.copyMetadata')}
                            icon={<Ionicons name="copy-outline" size={29} color="#007AFF" />}
                            onPress={handleCopyMetadata}
                        />
                    </ItemGroup>
                )}

                {/* Agent State */}
                {session.agentState && (
                    <ItemGroup title={t('sessionInfo.agentState')}>
                        <Item
                            title={t('sessionInfo.controlledByUser')}
                            detail={session.agentState.controlledByUser ? t('common.yes') : t('common.no')}
                            icon={<Ionicons name="person-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                        />
                        {session.agentState.requests && Object.keys(session.agentState.requests).length > 0 && (
                            <Item
                                title={t('sessionInfo.pendingRequests')}
                                detail={Object.keys(session.agentState.requests).length.toString()}
                                icon={<Ionicons name="hourglass-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Activity */}
                <ItemGroup title={t('sessionInfo.activity')}>
                    <Item
                        title={t('sessionInfo.thinking')}
                        detail={session.thinking ? t('common.yes') : t('common.no')}
                        icon={<Ionicons name="bulb-outline" size={29} color={session.thinking ? "#FFCC00" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    {session.thinking && (
                        <Item
                            title={t('sessionInfo.thinkingSince')}
                            subtitle={formatDate(session.thinkingAt)}
                            icon={<Ionicons name="timer-outline" size={29} color="#FFCC00" />}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>

                {/* Raw JSON (Dev Mode Only) */}
                {devModeEnabled && (
                    <ItemGroup title="Raw JSON (Dev Mode)">
                        {session.agentState && (
                            <>
                                <Item
                                    title="Agent State"
                                    icon={<Ionicons name="code-working-outline" size={29} color="#FF9500" />}
                                    showChevron={false}
                                />
                                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={JSON.stringify(session.agentState, null, 2)}
                                        language="json"
                                    />
                                </View>
                            </>
                        )}
                        {session.metadata && (
                            <>
                                <Item
                                    title="Metadata"
                                    icon={<Ionicons name="information-circle-outline" size={29} color="#5856D6" />}
                                    showChevron={false}
                                />
                                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={JSON.stringify(session.metadata, null, 2)}
                                        language="json"
                                    />
                                </View>
                            </>
                        )}
                        {sessionStatus && (
                            <>
                                <Item
                                    title="Session Status"
                                    icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                                    showChevron={false}
                                />
                                <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                                    <CodeView 
                                        code={JSON.stringify({
                                            isConnected: sessionStatus.isConnected,
                                            statusText: sessionStatus.statusText,
                                            statusColor: sessionStatus.statusColor,
                                            statusDotColor: sessionStatus.statusDotColor,
                                            isPulsing: sessionStatus.isPulsing
                                        }, null, 2)}
                                        language="json"
                                    />
                                </View>
                            </>
                        )}
                        {/* Full Session Object */}
                        <Item
                            title="Full Session Object"
                            icon={<Ionicons name="document-text-outline" size={29} color="#34C759" />}
                            showChevron={false}
                        />
                        <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                            <CodeView 
                                code={JSON.stringify(session, null, 2)}
                                language="json"
                            />
                        </View>
                    </ItemGroup>
                )}
            </ItemList>
        </>
    );
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);
    const isDataReady = useIsDataReady();

    // Handle three states: loading, deleted, and exists
    if (!isDataReady) {
        // Still loading data
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="hourglass-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 17, marginTop: 16, ...Typography.default('semiBold') }}>{t('common.loading')}</Text>
            </View>
        );
    }

    if (!session) {
        // Session has been deleted or doesn't exist
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, ...Typography.default('semiBold') }}>{t('errors.sessionDeleted')}</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() }}>{t('errors.sessionDeletedDescription')}</Text>
            </View>
        );
    }

    return <SessionInfoContent session={session} />;
});
