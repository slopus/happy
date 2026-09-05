import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, sessionArchive, sessionRequestArchiveMetadata, sessionRestoreMetadata, sessionKill, sessionDelete, sessionRegenerateTitle, sessionUpdateMetadata, forkAndSpawn, codexListRewindPoints, type ForkSource } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useMachine, useSetting } from '@/sync/storage';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { DuplicateSheet } from '@/components/DuplicateSheet';
import { hapticsSuccess } from '@/components/haptics';
import { getSessionName } from '@/utils/sessionUtils';
import { buildSessionTitleTranscript } from '@/utils/sessionTitleTranscript';
import { canRegenerateSessionTitle } from '@/utils/sessionTitleRegeneration';
import { buildSessionQuickActionItems } from './sessionQuickActionItems';
import { useSessionManagementPreferences } from './useSessionManagementPreferences';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import { buildDirectMessageForkOptions, resolveCodexMessageForkRewindPointId, type MessageForkTarget } from '@/utils/messageForkPoint';
import { describeSpawnSessionError } from '@/utils/spawnSessionError';

export interface SessionActionItem {
    id: string;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
    onSelectSession?: () => void;
}

type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function isRegenerateTitleRpcUnavailable(message: string | undefined): boolean {
    return message === 'RPC call failed'
        || message === 'RPC method not available'
        || message === 'Method not found';
}

function getResumeAvailability(session: Session, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    if (isConnected) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    const hasBackendResumeId = Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId);
    if (!hasBackendResumeId) {
        const message = t('sessionInfo.resumeSessionMissingBackendId');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!machine) {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterDelete,
        onAfterCopySessionMetadata,
        onSelectSession,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const expResumeSession = useSetting('expResumeSession');
    const sessionManagement = useSessionManagementPreferences([session.id], { prune: false });
    const sessionPinned = sessionManagement.isPinned(session.id);
    const resumeAvailability = React.useMemo(
        () => expResumeSession ? getResumeAvailability(session, machine, sessionStatus.isConnected) : { canResume: false, canShowResume: false, subtitle: '', message: '' },
        [machine, session, sessionStatus.isConnected, expResumeSession],
    );

    // Fork eligibility — separate from resume because fork works on both
    // active AND inactive provider sessions. The user-facing toggle is the same
    // expResumeSession experiment so all three flows (resume / fork /
    // duplicate) ride a single switch on settings/features.
    const forkSource = React.useMemo(() => getSessionForkSource(session), [
        session.id,
        session.metadata?.flavor,
        session.metadata?.machineId,
        session.metadata?.path,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
    const canFork = Boolean(
        expResumeSession
        && forkSource
        && machine
        && isMachineOnline(machine),
    );
    const canRegenerateTitle = canRegenerateSessionTitle(session);

    const openDetails = React.useCallback(() => {
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const copySessionMetadata = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const copySessionMetadataAndLogs = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataAndLogsToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const togglePinSession = React.useCallback(() => {
        sessionManagement.togglePinned(session.id);
    }, [session.id, sessionManagement]);

    const [resumingSession, performResume] = useHappyAction(async () => {
        if (!resumeAvailability.canResume) {
            throw new HappyError(resumeAvailability.message, false);
        }

        if (!machineId) {
            throw new HappyError(t('sessionInfo.resumeSessionMissingMachine'), false);
        }

        const modeMeta = resolveMessageModeMeta(session, storage.getState().settings);
        const result = await machineResumeSession({
            machineId,
            sessionId: session.id,
            model: modeMeta.model ?? undefined,
            permissionMode: modeMeta.permissionMode,
            effort: modeMeta.effort,
        });

        switch (result.type) {
            case 'success': {
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    storage.getState().updateSessionPermissionMode(result.sessionId, session.permissionMode);
                }
                if (session.modelMode) {
                    storage.getState().updateSessionModelMode(result.sessionId, session.modelMode);
                }
                if (session.effortLevel !== undefined) {
                    storage.getState().updateSessionEffortLevel(result.sessionId, session.effortLevel);
                }

                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        // Archive is durable encrypted lifecycle metadata. Transport `active`
        // remains presence-only, so an offline but resumable session is never
        // mistaken for an archived row.
        await sessionRequestArchiveMetadata(session);

        // Only wait for the kill RPC when presence proves the agent is
        // connected. Archived/offline rows have no responder, so calling the
        // RPC first would make this inline action stall until its ack timeout.
        const killResult = sessionStatus.isConnected && Boolean(session.metadata?.machineId)
            ? await sessionKill(session.id)
            : { success: false };
        if (!killResult.success) {
            const archiveResult = await sessionArchive(session.id);
            if (!archiveResult.success) {
                throw new HappyError(archiveResult.message || t('sessionInfo.failedToArchiveSession'), false);
            }
        }
        await sync.refreshSessions();
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const [restoringSession, performRestore] = useHappyAction(async () => {
        await sessionRestoreMetadata(session);
        await sync.refreshSessions();
        hapticsSuccess();
    });

    const restoreSession = React.useCallback(() => {
        performRestore();
    }, [performRestore]);

    const updateSessionTitle = React.useCallback(async (nextTitle: string) => {
        if (!session.metadata) {
            throw new HappyError(t('sessionInfo.renameSessionMissingMetadata'), false);
        }

        const trimmedTitle = nextTitle.trim();
        if (!trimmedTitle || trimmedTitle === getSessionName(session)) {
            return;
        }

        await sessionUpdateMetadata(
            session.id,
            session.metadata,
            session.metadataVersion,
            metadata => ({
                ...metadata,
                summary: {
                    text: trimmedTitle,
                    updatedAt: Date.now(),
                },
            }),
        );
    }, [session]);

    const [renamingFromPrompt, performRename] = useHappyAction(async () => {
        if (!session.metadata) {
            throw new HappyError(t('sessionInfo.renameSessionMissingMetadata'), false);
        }

        const currentTitle = getSessionName(session);
        const nextTitle = await Modal.prompt(
            t('sessionInfo.renameSession'),
            t('sessionInfo.renameSessionPrompt'),
            {
                defaultValue: currentTitle === t('session.newChat') ? '' : currentTitle,
                placeholder: t('sessionInfo.renameSessionPlaceholder'),
                cancelText: t('common.cancel'),
                confirmText: t('common.rename'),
            },
        );

        if (nextTitle === null) {
            return;
        }

        await updateSessionTitle(nextTitle);
    });

    const [renamingInline, performInlineRename] = useHappyAction(updateSessionTitle);
    const renamingSession = renamingFromPrompt || renamingInline;

    const renameSession = React.useCallback(() => {
        performRename();
    }, [performRename]);

    const renameSessionToTitle = React.useCallback((nextTitle: string) => {
        performInlineRename(nextTitle);
    }, [performInlineRename]);

    const [regeneratingTitle, performRegenerateTitle] = useHappyAction(async () => {
        if (!session.metadata || !sessionStatus.isConnected) {
            throw new HappyError(t('sessionInfo.regenerateTitleUnavailable'), false);
        }
        if (!canRegenerateTitle) {
            throw new HappyError(t('sessionInfo.regenerateTitleRequiresUpdatedCli'), false);
        }

        await sync.ensureMessagesLoaded(session.id);
        const messages = storage.getState().sessionMessages[session.id]?.messages ?? [];
        const transcript = buildSessionTitleTranscript(messages);
        if (!transcript) {
            throw new HappyError(t('sessionInfo.regenerateTitleNoMessages'), false);
        }

        const result = await sessionRegenerateTitle(session.id, {
            transcript,
            currentTitle: session.metadata.summary?.text ?? null,
            projectPath: session.metadata.path ?? null,
            model: session.modelMode ?? session.metadata.currentModelCode ?? null,
            effort: session.effortLevel ?? session.metadata.currentThoughtLevelCode ?? null,
        });
        if (!result.success) {
            const message = isRegenerateTitleRpcUnavailable(result.message)
                ? t('sessionInfo.regenerateTitleRequiresUpdatedCli')
                : result.message || t('sessionInfo.regenerateTitleFailed');
            throw new HappyError(message, false);
        }

        await sync.refreshSessions();
        hapticsSuccess();
    });

    const regenerateTitle = React.useCallback(() => {
        performRegenerateTitle();
    }, [performRegenerateTitle]);

    // Permanently delete a session. If it is still active, first try to stop
    // the CLI process so the server accepts the delete.
    const [deletingSession, performDelete] = useHappyAction(async () => {
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        // Best-effort kill in case the session reactivated between render and tap.
        if (sessionStatus.isConnected || session.active) {
            await sessionKill(session.id).catch(() => {});
        }

        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToDeleteSession'), false);
        }
        storage.getState().deleteSession(session.id);
        onAfterDelete?.();
    });

    const deleteSession = React.useCallback(() => {
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete,
                },
            ],
        );
    }, [performDelete]);

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    // Fork the session (no truncation) — copies the on-disk Claude JSONL
    // and spawns a fresh Happy session on the same machine. Works for
    // both active and inactive sessions; the source row stays untouched.
    const [forking, performFork] = useHappyAction(async () => {
        if (!canFork) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        if (!forkSource) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const result = await forkAndSpawn(forkSource as ForkSource);
        if (result.type !== 'success') {
            throw new HappyError(describeSpawnSessionError(result, t('session.forkErrorGeneric')), false);
        }
        hapticsSuccess();
        navigateToSession(result.sessionId);
    });

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    const [forkingFromMessage, performForkFromMessage] = useHappyAction(async (
        target: MessageForkTarget & { retainSelectedTurn?: boolean },
    ) => {
        if (!canFork || !forkSource) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        let resolvedTarget = target;
        if (forkSource.kind === 'codex' && !target.rewindPointId) {
            const rewindPointsResult = await codexListRewindPoints({
                machineId: forkSource.machineId,
                directory: forkSource.directory,
                codexThreadId: forkSource.codexThreadId,
            });
            if (rewindPointsResult.type !== 'success') {
                throw new HappyError(rewindPointsResult.errorMessage, false);
            }
            const rewindPointId = resolveCodexMessageForkRewindPointId(rewindPointsResult.points, target);
            if (!rewindPointId) {
                throw new HappyError(t('session.forkErrorMissingMetadata'), false);
            }
            resolvedTarget = { ...target, rewindPointId };
        }
        const forkOptions = buildDirectMessageForkOptions(forkSource.kind, resolvedTarget);
        if (!forkOptions) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const result = await forkAndSpawn(forkSource as ForkSource, forkOptions);
        if (result.type !== 'success') {
            throw new HappyError(describeSpawnSessionError(result, t('session.forkErrorGeneric')), false);
        }
        hapticsSuccess();
        navigateToSession(result.sessionId);
    }, { fallbackErrorMessage: t('session.forkErrorGeneric') });
    const [forkingFromMessageId, setForkingFromMessageId] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!forkingFromMessage) setForkingFromMessageId(null);
    }, [forkingFromMessage]);

    const forkFromMessage = React.useCallback((
        target: MessageForkTarget & { retainSelectedTurn?: boolean },
    ) => {
        if (performForkFromMessage(target)) {
            setForkingFromMessageId(target.messageId);
        }
    }, [performForkFromMessage]);

    const openDuplicateSheet = React.useCallback(() => {
        if (!canFork) return;
        Modal.show({
            component: DuplicateSheet,
            props: { sessionId: session.id },
        } as any);
    }, [canFork, session.id]);

    const canCopySessionMetadata = false;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const sessionArchived = isSessionArchived(session);
        return buildSessionQuickActionItems({
            labels: {
                pin: t('sessionInfo.pinSession'),
                unpin: t('sessionInfo.unpinSession'),
                details: t('profile.details'),
                resume: t('sessionInfo.resumeSession'),
                rename: t('sessionInfo.renameSession'),
                regenerateTitle: t('sessionInfo.regenerateTitle'),
                fork: t('session.forkAction'),
                duplicate: t('session.duplicateAction'),
                copyMetadata: t('sessionInfo.copyMetadata'),
                copyMetadataAndLogs: t('sessionInfo.copyMetadata') + ' & Client Logs',
                archive: t('sessionInfo.archiveSession'),
                restore: t('sessionInfo.restoreSession'),
                delete: t('sessionInfo.deleteSession'),
                select: t('sessionInfo.selectSession'),
            },
            callbacks: {
                togglePinSession,
                openDetails,
                resumeSession,
                renameSession,
                regenerateTitle,
                forkSession,
                openDuplicateSheet,
                copySessionMetadata,
                copySessionMetadataAndLogs,
                archiveSession,
                restoreSession,
                deleteSession,
                selectSession: onSelectSession,
            },
            canShowResume: resumeAvailability.canShowResume,
            canRegenerateTitle,
            canFork,
            canCopySessionMetadata,
            sessionPinned,
            sessionActive: !sessionArchived,
            sessionArchived,
            canSelect: Boolean(onSelectSession),
        });
    }, [
        archiveSession,
        canCopySessionMetadata,
        canRegenerateTitle,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        deleteSession,
        forkSession,
        openDetails,
        openDuplicateSheet,
        onSelectSession,
        regenerateTitle,
        renameSession,
        resumeAvailability.canShowResume,
        resumeSession,
        restoreSession,
        session.active,
        session.metadata?.lifecycleState,
        sessionPinned,
        togglePinSession,
    ]);

    const showActionAlert = React.useCallback(() => {
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = actionItems.map(item => ({
            text: item.label,
            onPress: item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert('Session', undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        archiveSession,
        archivingSession,
        canArchive: session.active,
        canDelete: true,
        deleteSession,
        deletingSession,
        canCopySessionMetadata,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canFork,
        canRegenerateTitle,
        sessionPinned,
        togglePinSession,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        forkFromMessage,
        forkingFromMessage,
        forkingFromMessageId,
        openDetails,
        openDuplicateSheet,
        regenerateTitle,
        regeneratingTitle,
        renameSession,
        renameSessionToTitle,
        renamingSession,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
        restoreSession,
        restoringSession,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile.
 */
export function useSessionActionAlert(sessionId: string) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session!, {});
    return session ? showActionAlert : undefined;
}
