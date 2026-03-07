import React, { useCallback } from 'react';
import { View, Text, Animated, Pressable, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Avatar } from '@/components/Avatar';
import { useSession, useIsDataReady, useMachine, storage } from '@/sync/storage';
import { generateCopyTitle, getSessionName, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId } from '@/utils/sessionUtils';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { hapticsLight } from '@/components/haptics';
import { showCopiedToast } from '@/components/Toast';
import { sessionKill, sessionDelete, machineForkClaudeSession, machineForkGeminiSession, machineForkCodexSession, machineSpawnNewSession, sessionUpdateSummary, sessionUpdateMetadataFields } from '@/sync/ops';
import { pushWorktreeBranch, mergeWorktreeBranch, createWorktreePR, cleanupWorktree, cleanupWorkspace, getLocalBranches, getCurrentBranch } from '@/utils/worktreeOps';
import { getWorkspaceRepos } from '@/utils/workspaceRepos';
import { RepoSelector } from '@/components/RepoSelector';
import { ActionMenuModal } from '@/components/ActionMenuModal';
import { ActionMenuItem } from '@/components/ActionMenu';
import { buildReviewPrompt } from '@/utils/reviewPrompt';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { isVersionSupported, useLatestCliVersion } from '@/utils/versionUtils';
import { CodeView } from '@/components/CodeView';
import { Session } from '@/sync/storageTypes';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { formatModelDisplay, resolveLocalModelDisplay } from '@/constants/modelCatalog';

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
    const isOwner = !session.accessLevel;
    const isAdmin = isOwner || session.accessLevel === 'admin';
    const localModelDisplay = React.useMemo(() => resolveLocalModelDisplay(session.modelMode), [session.modelMode]);
    const modelSubtitle = React.useMemo(() => {
        const cliModel = session.metadata?.model;
        const cliEffort = session.metadata?.reasoningEffort;
        const cliLabel = formatModelDisplay(cliModel, cliEffort);

        const localLabel = formatModelDisplay(localModelDisplay.model, localModelDisplay.reasoningEffort);

        if (cliLabel && localLabel && cliLabel !== localLabel) {
            return `${cliLabel} → ${localLabel}`;
        }
        return cliLabel || localLabel;
    }, [localModelDisplay.model, localModelDisplay.reasoningEffort, session.metadata?.model, session.metadata?.reasoningEffort]);
    const geminiSessionId = session.metadata?.flavor === 'gemini' ? session.id : undefined;
    
    // Check if CLI version is outdated
    const latestCliVersion = useLatestCliVersion();
    const isCliOutdated = session.metadata?.version && latestCliVersion && !isVersionSupported(session.metadata.version, latestCliVersion);

    // Check if machine daemon has a newer CLI version than this session
    const machineId = session.metadata?.machineId;
    const machine = useMachine(machineId ?? '');
    const machineDaemonVersion = machine?.metadata?.happyCliVersion;
    const sessionVersion = session.metadata?.version;
    const isUpgradeAvailable = sessionVersion && machineDaemonVersion
        && !machineDaemonVersion.startsWith('0.14.0-dev.') // Skip legacy dev versions
        && !isVersionSupported(sessionVersion, machineDaemonVersion)
        && machineDaemonVersion !== sessionVersion;

    const handleCopySessionId = useCallback(async () => {
        if (!session) return;
        try {
            await Clipboard.setStringAsync(session.id);
            hapticsLight(); showCopiedToast();
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopySessionId'));
        }
    }, [session]);

    const handleCopyMetadata = useCallback(async () => {
        if (!session?.metadata) return;
        try {
            await Clipboard.setStringAsync(JSON.stringify(session.metadata, null, 2));
            hapticsLight(); showCopiedToast();
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyMetadata'));
        }
    }, [session]);

    const handleCopyClaudeSessionId = useCallback(async () => {
        const claudeSessionId = session.metadata?.claudeSessionId;
        if (!claudeSessionId) return;
        try {
            await Clipboard.setStringAsync(claudeSessionId);
            hapticsLight(); showCopiedToast();
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyClaudeCodeSessionId'));
        }
    }, [session.metadata?.claudeSessionId]);

    const handleCopyCodexSessionId = useCallback(async () => {
        const codexSessionId = session.metadata?.codexSessionId;
        if (!codexSessionId) return;
        try {
            await Clipboard.setStringAsync(codexSessionId);
            hapticsLight(); showCopiedToast();
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyCodexSessionId'));
        }
    }, [session.metadata?.codexSessionId]);

    const handleCopyGeminiSessionId = useCallback(async () => {
        if (!geminiSessionId) return;
        try {
            await Clipboard.setStringAsync(geminiSessionId);
            hapticsLight(); showCopiedToast();
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopyGeminiSessionId'));
        }
    }, [geminiSessionId]);

    // Worktree state: unified multi-repo + legacy single-repo support
    const workspaceRepos = getWorkspaceRepos(session.metadata);
    const [selectedRepoIndex, setSelectedRepoIndex] = React.useState(0);
    const selectedRepo = workspaceRepos[selectedRepoIndex];
    const isWorktree = workspaceRepos.length > 0;
    const isMultiRepo = workspaceRepos.length > 1;
    const worktreeMachineId = session.metadata?.machineId;
    const worktreeBranch = selectedRepo?.branchName;
    const worktreeBasePath = selectedRepo?.basePath;
    const worktreePath = selectedRepo?.path;

    // Use HappyAction for archiving - it handles errors automatically
    const [archivingSession, performArchive] = useHappyAction(async () => {
        const previousActive = storage.getState().sessions[session.id]?.active ?? session.active;
        storage.getState().updateSessionActivity(session.id, false);

        const result = await sessionKill(session.id);
        const errorMessage = result.message || t('sessionInfo.failedToArchiveSession');

        // Archiving is idempotent: if RPC target is gone, session is effectively already archived.
        if (!result.success && /RPC method not available/i.test(errorMessage)) {
            router.back();
            router.back();
            return;
        }

        if (!result.success) {
            storage.getState().updateSessionActivity(session.id, previousActive);
            throw new HappyError(errorMessage, false);
        }

        // Success - navigate back
        router.back();
        router.back();
    });

    // Archive menu for worktree sessions
    const [archiveMenuVisible, setArchiveMenuVisible] = React.useState(false);
    const [archiveMenuItems, setArchiveMenuItems] = React.useState<ActionMenuItem[]>([]);

    const handleArchiveSession = useCallback(() => {
        if (isWorktree && worktreeMachineId) {
            const machineId = worktreeMachineId;
            setArchiveMenuItems([
                {
                    label: t('sessionInfo.worktree.archiveKeepWorktree'),
                    onPress: () => { setArchiveMenuVisible(false); performArchive(); },
                },
                {
                    label: t('sessionInfo.worktree.archiveCleanupKeepBranch'),
                    onPress: async () => {
                        setArchiveMenuVisible(false);
                        try {
                            if (isMultiRepo && session.metadata?.workspacePath) {
                                await cleanupWorkspace(machineId, session.metadata.workspacePath, workspaceRepos, false);
                            } else if (worktreeBasePath && worktreeBranch) {
                                await cleanupWorktree(machineId, worktreeBasePath, worktreeBranch, false);
                            }
                        } catch (e) { console.warn('Worktree cleanup failed:', e); }
                        await performArchive();
                    },
                },
                {
                    label: t('sessionInfo.worktree.archiveCleanupDeleteBranch'),
                    destructive: true,
                    onPress: async () => {
                        setArchiveMenuVisible(false);
                        try {
                            if (isMultiRepo && session.metadata?.workspacePath) {
                                await cleanupWorkspace(machineId, session.metadata.workspacePath, workspaceRepos, true);
                            } else if (worktreeBasePath && worktreeBranch) {
                                await cleanupWorktree(machineId, worktreeBasePath, worktreeBranch, true);
                            }
                        } catch (e) { console.warn('Worktree cleanup failed:', e); }
                        await performArchive();
                    },
                },
            ]);
            setArchiveMenuVisible(true);
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
    }, [performArchive, session.metadata, isWorktree, isMultiRepo, worktreeMachineId, worktreeBasePath, worktreeBranch, workspaceRepos]);

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
        const flavor = session.metadata?.flavor;
        const claudeSessionId = session.metadata?.claudeSessionId;
        const codexSessionId = session.metadata?.codexSessionId;
        const machineId = session.metadata?.machineId;
        const directory = session.metadata?.path;

        const hasForkableId = claudeSessionId || flavor === 'gemini' || codexSessionId;
        if (!hasForkableId || !directory || !machineId) return;

        const isOnline = session.active;
        const provider = flavor === 'gemini' ? 'Gemini' : flavor === 'codex' ? 'Codex' : 'Claude';
        const confirmTitle = isOnline ? t('sessionHistory.copyConfirmTitle') : t('sessionHistory.resumeConfirmTitle');
        const confirmMessage = isOnline ? t('sessionHistory.copyConfirmMessage', { provider }) : t('sessionHistory.resumeConfirmMessage', { provider });
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
                sessionTitle = generateCopyTitle(originalTitle);
            }

            let resumeSessionId: string | undefined;
            let agent: 'claude' | 'gemini' | 'codex' = 'claude';

            if (flavor === 'gemini') {
                const forkResult = await machineForkGeminiSession(machineId, session.id);
                if (!forkResult.success || !forkResult.newSessionId) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newSessionId;
                agent = 'gemini';
            } else if (flavor === 'codex' && codexSessionId) {
                const forkResult = await machineForkCodexSession(machineId, codexSessionId);
                if (!forkResult.success || !forkResult.newFilePath) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newFilePath;
                agent = 'codex';
            } else if (claudeSessionId) {
                const forkResult = await machineForkClaudeSession(machineId, claudeSessionId);
                if (!forkResult.success || !forkResult.newSessionId) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newSessionId;
                agent = 'claude';
            } else {
                return;
            }

            const result = await machineSpawnNewSession({
                machineId,
                directory,
                approvedNewDirectoryCreation: false,
                agent,
                resumeSessionId,
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

    const handleCopyUpdateCommand = useCallback(() => {
        Modal.alert(
            t('sessionInfo.cliVersionOutdated'),
            t('sessionInfo.updateCliInstructions'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.copy'),
                    onPress: async () => {
                        const updateCommand = 'npm install -g happy-next-cli@latest';
                        await Clipboard.setStringAsync(updateCommand);
                        hapticsLight();
                        showCopiedToast();
                    }
                }
            ]
        );
    }, []);

    const [isUpgrading, setIsUpgrading] = React.useState(false);
    const handleUpgradeSession = useCallback(async () => {
        if (!session || !machineId || isUpgrading) return;

        // Block if session is thinking
        if (session.thinking) {
            Modal.alert(
                t('sessionInfo.cliUpgradeAvailable'),
                t('sessionInfo.cliUpgradeSessionBusy')
            );
            return;
        }

        // Confirm before upgrading
        const confirmed = await Modal.confirm(
            t('sessionInfo.cliUpgradeAvailable'),
            t('sessionInfo.cliUpgradeConfirm')
        );
        if (!confirmed) return;

        // Set upgrading flag only after confirmation
        setIsUpgrading(true);
        storage.getState().setSessionUpgrading(session.id, true);

        try {
            // Kill old session
            await sessionKill(session.id);

            // Fork and resume — mirrors the "resume session" flow exactly
            const flavor = session.metadata?.flavor;
            let resumeSessionId: string | undefined;
            let agent: 'claude' | 'codex' | 'gemini' = 'claude';

            if (flavor === 'gemini') {
                const forkResult = await machineForkGeminiSession(machineId, session.id);
                if (!forkResult.success || !forkResult.newSessionId) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newSessionId;
                agent = 'gemini';
            } else if (flavor === 'codex' && session.metadata?.codexSessionId) {
                const forkResult = await machineForkCodexSession(machineId, session.metadata.codexSessionId);
                if (!forkResult.success || !forkResult.newFilePath) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newFilePath;
                agent = 'codex';
            } else if (session.metadata?.claudeSessionId) {
                const forkResult = await machineForkClaudeSession(machineId, session.metadata.claudeSessionId);
                if (!forkResult.success || !forkResult.newSessionId) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newSessionId;
                agent = 'claude';
            } else {
                Modal.alert(t('common.error'), t('claudeHistory.resumeFailed'));
                return;
            }

            // Spawn new session with forked data
            const result = await machineSpawnNewSession({
                machineId,
                directory: session.metadata?.path || '',
                agent,
                resumeSessionId,
                skipForkSession: true,
                sessionTitle: session.metadata?.summary?.text,
            });

            if (result.type !== 'success') {
                Modal.alert(t('common.error'), result.type === 'error' ? result.errorMessage : 'Upgrade failed');
                return;
            }

            // Navigate to the new session: go back to root then push new session
            try { router.dismissAll(); } catch (_) { /* stack may already be at root */ }
            router.push(`/session/${result.sessionId}`);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setIsUpgrading(false);
            storage.getState().setSessionUpgrading(session.id, false);
        }
    }, [session, machineId, router, isUpgrading]);

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

    // Shared branch picker state for merge & PR
    const [branchPickerVisible, setBranchPickerVisible] = React.useState(false);
    const [branchPickerTitle, setBranchPickerTitle] = React.useState('');
    const [branchPickerItems, setBranchPickerItems] = React.useState<ActionMenuItem[]>([]);

    const showBranchPicker = React.useCallback(async (
        title: string,
        onSelect: (branch: string) => void,
    ) => {
        if (!worktreeMachineId || !worktreeBranch || !worktreeBasePath) return;
        const [branches, current] = await Promise.all([
            getLocalBranches(worktreeMachineId, worktreeBasePath),
            getCurrentBranch(worktreeMachineId, worktreeBasePath),
        ]);
        const candidates = branches.filter(b => b !== worktreeBranch);
        if (candidates.length === 0) {
            throw new HappyError(t('sessionInfo.worktree.mergeFailed'), false);
        }
        setBranchPickerTitle(title);
        setBranchPickerItems(candidates.map(branch => ({
            label: branch,
            selected: branch === current,
            onPress: () => {
                setBranchPickerVisible(false);
                onSelect(branch);
            },
        })));
        setBranchPickerVisible(true);
    }, [worktreeMachineId, worktreeBranch, worktreeBasePath]);

    // Create PR with branch selection
    const [creatingPR, setCreatingPR] = React.useState(false);

    const doCreatePR = React.useCallback(async (baseBranch: string) => {
        if (!worktreeMachineId || !worktreeBranch || !worktreePath) return;
        try {
            const sessionTitle = session.metadata?.summary?.text || getSessionName(session);
            const confirmed = await Modal.confirm(
                t('sessionInfo.worktree.createPR'),
                t('sessionInfo.worktree.createPRConfirmTarget', { branch: worktreeBranch, target: baseBranch })
            );
            if (!confirmed) return;
            setCreatingPR(true);
            try {
                const result = await createWorktreePR(worktreeMachineId, worktreePath, worktreeBranch, sessionTitle, baseBranch);
                if (!result.success) {
                    if (result.error === 'gh_not_installed') {
                        Modal.alert(t('common.error'), t('sessionInfo.worktree.ghNotInstalled'));
                        return;
                    }
                    Modal.alert(t('common.error'), result.error || t('sessionInfo.worktree.createPRFailed'));
                    return;
                }
                // Persist PR URL in session metadata
                if (result.prUrl && session.metadata) {
                    try {
                        if (isMultiRepo && session.metadata.workspaceRepos) {
                            // Update the specific repo's prUrl in the workspaceRepos array
                            const updatedRepos = session.metadata.workspaceRepos.map((r, i) =>
                                i === selectedRepoIndex ? { ...r, prUrl: result.prUrl } : r
                            );
                            await sessionUpdateMetadataFields(
                                session.id,
                                session.metadata,
                                { workspaceRepos: updatedRepos },
                                session.metadataVersion
                            );
                        } else {
                            await sessionUpdateMetadataFields(
                                session.id,
                                session.metadata,
                                { worktreePrUrl: result.prUrl },
                                session.metadataVersion
                            );
                        }
                    } catch (e) {
                        console.warn('Failed to save PR URL to metadata:', e);
                    }
                }
                Modal.alert(t('common.success'), t('sessionInfo.worktree.createPRSuccess', { url: result.prUrl || '' }));
            } finally {
                setCreatingPR(false);
            }
        } catch (e) {
            setCreatingPR(false);
            Modal.alert(t('common.error'), t('sessionInfo.worktree.createPRFailed'));
        }
    }, [worktreeMachineId, worktreeBranch, worktreePath, session, isMultiRepo, selectedRepoIndex]);

    const handleCreatePR = React.useCallback(async () => {
        if (!worktreeMachineId || !worktreeBranch || !worktreePath) return;
        await showBranchPicker(t('sessionInfo.worktree.selectPRBase'), doCreatePR);
    }, [worktreeMachineId, worktreeBranch, worktreePath, showBranchPicker, doCreatePR]);

    // Merge branch with branch selection
    const [mergingBranch, setMergingBranch] = React.useState(false);

    const doMergeBranch = React.useCallback(async (targetBranch: string) => {
        if (!worktreeMachineId || !worktreeBranch || !worktreeBasePath) return;
        try {
            const confirmed = await Modal.confirm(
                t('sessionInfo.worktree.mergeBranch'),
                t('sessionInfo.worktree.mergeConfirmTarget', { branch: worktreeBranch, target: targetBranch })
            );
            if (!confirmed) return;
            setMergingBranch(true);
            try {
                const result = await mergeWorktreeBranch(worktreeMachineId, worktreeBasePath, worktreeBranch, targetBranch);
                if (!result.success) {
                    if (result.hasConflicts) {
                        Modal.alert(t('common.error'), t('sessionInfo.worktree.mergeConflicts'));
                        return;
                    }
                    Modal.alert(t('common.error'), result.error || t('sessionInfo.worktree.mergeFailed'));
                    return;
                }
                Modal.alert(t('common.success'), t('sessionInfo.worktree.mergeSuccess'));
            } finally {
                setMergingBranch(false);
            }
        } catch (e) {
            setMergingBranch(false);
            Modal.alert(t('common.error'), t('sessionInfo.worktree.mergeFailed'));
        }
    }, [worktreeMachineId, worktreeBranch, worktreeBasePath]);

    const handleMergeBranch = React.useCallback(async () => {
        if (!worktreeMachineId || !worktreeBranch || !worktreeBasePath) return;
        await showBranchPicker(t('sessionInfo.worktree.selectMergeTarget'), doMergeBranch);
    }, [worktreeMachineId, worktreeBranch, worktreeBasePath, showBranchPicker, doMergeBranch]);

    // Cleanup worktree menu
    const [cleanupMenuVisible, setCleanupMenuVisible] = React.useState(false);
    const [cleaningUp, setCleaningUp] = React.useState(false);

    const doCleanupWorktree = React.useCallback(async (deleteBranch: boolean) => {
        if (!worktreeMachineId) return;
        setCleaningUp(true);
        try {
            if (isMultiRepo && session.metadata?.workspacePath) {
                const result = await cleanupWorkspace(worktreeMachineId, session.metadata.workspacePath, workspaceRepos, deleteBranch);
                if (!result.success) {
                    Modal.alert(t('common.error'), result.errors.join('\n') || t('sessionInfo.worktree.cleanupFailed'));
                    return;
                }
                Modal.alert(t('common.success'), t('sessionInfo.worktree.cleanupSuccess'));
            } else {
                if (!worktreeBranch || !worktreeBasePath) return;
                const result = await cleanupWorktree(worktreeMachineId, worktreeBasePath, worktreeBranch, deleteBranch);
                if (!result.success) {
                    Modal.alert(t('common.error'), result.error || t('sessionInfo.worktree.cleanupFailed'));
                    return;
                }
                if (result.error) {
                    // Partial success (worktree removed but branch deletion failed)
                    Modal.alert(t('common.success'), result.error);
                } else {
                    Modal.alert(t('common.success'), t('sessionInfo.worktree.cleanupSuccess'));
                }
            }
        } catch (e) {
            Modal.alert(t('common.error'), t('sessionInfo.worktree.cleanupFailed'));
        } finally {
            setCleaningUp(false);
        }
    }, [worktreeMachineId, worktreeBranch, worktreeBasePath, isMultiRepo, workspaceRepos, session.metadata?.workspacePath]);

    const handleCleanupWorktree = React.useCallback(() => {
        setCleanupMenuVisible(true);
    }, []);

    // Review agent selection menu
    const [reviewMenuVisible, setReviewMenuVisible] = React.useState(false);
    const [requestingReview, setRequestingReview] = React.useState(false);

    const doRequestReview = React.useCallback(async (agentChoice: 'claude' | 'codex' | 'gemini') => {
        if (!worktreeMachineId || !worktreeBranch || !worktreePath) return;
        const prUrl = selectedRepo?.prUrl;
        if (!prUrl) return;

        setRequestingReview(true);
        try {
            // Spawn review session in same worktree
            const originalTitle = session.metadata?.summary?.text || getSessionName(session);
            const result = await machineSpawnNewSession({
                machineId: worktreeMachineId,
                directory: worktreePath,
                approvedNewDirectoryCreation: false,
                agent: agentChoice,
                sessionTitle: `Review: ${originalTitle}`,
                worktreeBasePath,
                worktreeBranchName: worktreeBranch,
            });
            if (result.type === 'error') {
                Modal.alert(t('common.error'), result.errorMessage || t('sessionInfo.worktree.reviewSpawnFailed'));
                return;
            }
            if (result.type !== 'success') {
                Modal.alert(t('common.error'), t('sessionInfo.worktree.reviewSpawnFailed'));
                return;
            }

            await sync.refreshSessions();

            // Link review session back to the original session
            const reviewSession = storage.getState().sessions[result.sessionId];
            if (reviewSession?.metadata) {
                try {
                    await sessionUpdateMetadataFields(
                        result.sessionId,
                        reviewSession.metadata,
                        { reviewOfSessionId: session.id, worktreePrUrl: prUrl },
                        reviewSession.metadataVersion
                    );
                } catch (e) {
                    console.warn('Failed to set reviewOfSessionId on review session:', e);
                }
            }

            // Send review prompt as first message
            const reviewPrompt = buildReviewPrompt(prUrl, worktreeBranch, agentChoice);
            await sync.sendMessage(result.sessionId, reviewPrompt);

            // Navigate to the review session
            router.push(`/session/${result.sessionId}`);
        } catch (e) {
            Modal.alert(t('common.error'), t('sessionInfo.worktree.reviewSpawnFailed'));
        } finally {
            setRequestingReview(false);
        }
    }, [worktreeMachineId, worktreeBranch, worktreePath, worktreeBasePath, session, router, selectedRepo]);

    const handleRequestReview = React.useCallback(() => {
        if (!selectedRepo?.prUrl) {
            Modal.alert(t('common.error'), t('sessionInfo.worktree.reviewNoPR'));
            return;
        }
        setReviewMenuVisible(true);
    }, [selectedRepo?.prUrl]);

    return (
        <>
            <ItemList>
                {/* Session Header */}
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginBottom: 8, borderRadius: 12, marginHorizontal: 16, marginTop: 16 }}>
                        <Avatar id={getSessionAvatarId(session)} size={80} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} sessionIcon={session.metadata?.sessionIcon} />
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

                {/* CLI Version Warning - only show install instructions when machine hasn't updated yet */}
                {isCliOutdated && !isUpgradeAvailable && session.active && (
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

                {/* CLI Upgrade Available - shown when machine has newer CLI than session */}
                {isUpgradeAvailable && (session.active || isUpgrading) && (
                    <ItemGroup>
                        <Item
                            title={isUpgrading ? t('sessionInfo.cliUpgradeInProgress') : t('sessionInfo.cliUpgradeAvailable')}
                            subtitle={t('sessionInfo.cliUpgradeAvailableSubtitle')}
                            icon={<Ionicons name="arrow-up-circle-outline" size={29} color="#34C759" />}
                            showChevron={!isUpgrading}
                            onPress={isUpgrading ? undefined : handleUpgradeSession}
                        />
                    </ItemGroup>
                )}

                {/* Repository */}
                {isAdmin && session.metadata?.path && sessionStatus.isConnected && (
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
                            onPress={handleCopyClaudeSessionId}
                        />
                    )}
                    {session.metadata?.codexSessionId && (
                        <Item
                            title={t('sessionInfo.codexSessionId')}
                            subtitle={`${session.metadata.codexSessionId.substring(0, 8)}...${session.metadata.codexSessionId.substring(session.metadata.codexSessionId.length - 8)}`}
                            icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                            onPress={handleCopyCodexSessionId}
                        />
                    )}
                    {geminiSessionId && (
                        <Item
                            title={t('sessionInfo.geminiSessionId')}
                            subtitle={`${geminiSessionId.substring(0, 8)}...${geminiSessionId.substring(geminiSessionId.length - 8)}`}
                            icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                            onPress={handleCopyGeminiSessionId}
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

                {/* Quick Actions - only show when user has admin/owner permissions */}
                {isAdmin && (
                    <ItemGroup title={t('sessionInfo.quickActions')}>
                        {isAdmin && (
                            <Item
                                title={t('session.sharing.manageSharing')}
                                subtitle={t('session.sharing.manageSharingSubtitle')}
                                icon={<Ionicons name="share-outline" size={29} color="#007AFF" />}
                                onPress={() => router.push(`/session/${session.id}/sharing`)}
                            />
                        )}
                        {isOwner && session.metadata?.machineId && (
                            <Item
                                title={t('sessionInfo.viewMachine')}
                                subtitle={t('sessionInfo.viewMachineSubtitle')}
                                icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                                onPress={() => router.push(`/machine/${session.metadata?.machineId}`)}
                            />
                        )}
                        {isOwner && (session.metadata?.claudeSessionId || session.metadata?.flavor === 'gemini' || session.metadata?.codexSessionId) && session.metadata?.machineId && session.metadata?.path && (
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
                        {isAdmin && sessionStatus.isConnected && (
                            <Item
                                title={t('sessionInfo.archiveSession')}
                                subtitle={t('sessionInfo.archiveSessionSubtitle')}
                                icon={<Ionicons name="archive-outline" size={29} color="#FF3B30" />}
                                onPress={handleArchiveSession}
                            />
                        )}
                        {isOwner && !sessionStatus.isConnected && !session.active && (
                            <Item
                                title={t('sessionInfo.deleteSession')}
                                subtitle={t('sessionInfo.deleteSessionSubtitle')}
                                icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                                onPress={handleDeleteSession}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Worktree Info & Actions */}
                {isMultiRepo && (
                    <View style={{ alignItems: 'center' }}>
                        <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingHorizontal: Platform.select({ ios: 0, default: 4 }), marginHorizontal: Platform.select({ ios: 16, default: 12 }), marginTop: 20 }}>
                            <RepoSelector
                                repos={workspaceRepos}
                                selectedIndex={selectedRepoIndex}
                                onSelect={setSelectedRepoIndex}
                            />
                        </View>
                    </View>
                )}
                {isWorktree && worktreeBranch && (
                    <ItemGroup title={t('sessionInfo.worktree.title')} headerStyle={isMultiRepo ? { paddingTop: 12 } : undefined}>
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
                        {selectedRepo?.prUrl && (
                            <Item
                                title={t('sessionInfo.worktree.prLink')}
                                subtitle={selectedRepo.prUrl}
                                icon={<Ionicons name="git-pull-request-outline" size={29} color="#34C759" />}
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
                        {selectedRepo?.prUrl && (
                            <Item
                                title={t('sessionInfo.worktree.requestReview')}
                                subtitle={t('sessionInfo.worktree.requestReviewSubtitle')}
                                icon={<Ionicons name="eye-outline" size={29} color="#5856D6" />}
                                onPress={handleRequestReview}
                                loading={requestingReview}
                                disabled={requestingReview}
                            />
                        )}
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
                                detail={isCliOutdated && session.active ? '⚠️' : undefined}
                                icon={<Ionicons name="git-branch-outline" size={29} color={isCliOutdated && session.active ? "#FF9500" : "#5856D6"} />}
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
                                if (flavor === 'codex') return 'Codex';
                                if (flavor === 'gpt' || flavor === 'openai') return 'Codex';
                                if (flavor === 'gemini') return 'Gemini';
                                return flavor;
                            })()}
                            icon={<Ionicons name="sparkles-outline" size={29} color="#5856D6" />}
                            showChevron={false}
                        />
                        {modelSubtitle && (
                            <Item
                                title={t('sessionInfo.model')}
                                subtitle={modelSubtitle}
                                icon={<Ionicons name="options-outline" size={29} color="#5856D6" />}
                                showChevron={false}
                            />
                        )}
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
            <ActionMenuModal
                visible={branchPickerVisible}
                title={branchPickerTitle}
                items={branchPickerItems}
                onClose={() => setBranchPickerVisible(false)}
            />
            <ActionMenuModal
                visible={archiveMenuVisible}
                title={t('sessionInfo.worktree.archiveWorktreeConfirm')}
                items={archiveMenuItems}
                onClose={() => setArchiveMenuVisible(false)}
            />
            <ActionMenuModal
                visible={cleanupMenuVisible}
                title={t('sessionInfo.worktree.cleanupConfirm')}
                items={[
                    {
                        label: t('sessionInfo.worktree.cleanupKeepBranch'),
                        onPress: () => { setCleanupMenuVisible(false); doCleanupWorktree(false); },
                    },
                    {
                        label: t('sessionInfo.worktree.cleanupDeleteBranch'),
                        destructive: true,
                        onPress: () => { setCleanupMenuVisible(false); doCleanupWorktree(true); },
                    },
                ]}
                onClose={() => setCleanupMenuVisible(false)}
            />
            <ActionMenuModal
                visible={reviewMenuVisible}
                title={t('sessionInfo.worktree.reviewSelectAgentMessage')}
                items={[
                    {
                        label: 'Claude',
                        onPress: () => { setReviewMenuVisible(false); doRequestReview('claude'); },
                    },
                    {
                        label: 'Codex',
                        onPress: () => { setReviewMenuVisible(false); doRequestReview('codex'); },
                    },
                    {
                        label: 'Gemini',
                        onPress: () => { setReviewMenuVisible(false); doRequestReview('gemini'); },
                    },
                ]}
                onClose={() => setReviewMenuVisible(false)}
            />
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
