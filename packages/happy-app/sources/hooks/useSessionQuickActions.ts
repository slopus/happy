import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, sessionDelete, sessionForceDeactivate, sessionKill, sessionSetAgentModes, sessionSetArchived, sessionSetPinned, forkAndSpawn, type ForkSource } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useLocalSetting, useMachine, useSetting } from '@/sync/storage';
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
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { isRigMetadata } from '@/sync/rig';
import { getSessionResumeFallback } from '@/utils/sessionResumeFallback';

export interface SessionActionItem {
    id: SessionActionShortcutId;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
}

/**
 * Stop the agent behind a session: ask the CLI to exit, and if nothing answers
 * (process already gone, daemon offline) force the row inactive server-side so
 * it stops claiming to be live. Worktree cleanup is offered first because it
 * needs the machine connection this is about to end.
 */
async function stopSessionProcess(session: Session): Promise<void> {
    await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);
    const killResult = await sessionKill(session.id);
    if (!killResult.success) {
        await sessionForceDeactivate(session.id);
    }
}

type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function getResumeAvailability(session: Session, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    if (isRigMetadata(session.metadata) || session.metadata?.capabilities?.resume === false) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }
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
        onAfterCopySessionMetadata,
        onAfterDelete,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const expResumeSession = useSetting('expResumeSession');
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
        && !isRigMetadata(session.metadata)
        && forkSource
        && machine
        && isMachineOnline(machine),
    );

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
            effort: modeMeta.effort ?? undefined,
            fallback: getSessionResumeFallback(session.metadata),
        });

        switch (result.type) {
            case 'success': {
                // Usually this reconnects the same Happy ID. If the daemon has
                // no local reconnect key, it may instead continue the provider
                // conversation in a fresh Happy row and return that new ID.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    sessionSetAgentModes(result.sessionId, { permissionMode: session.permissionMode });
                }
                // Model / effort picks survive in-place resume through synced
                // metadata (#1492), and the fallback spawn receives them above.

                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    });

    const isArchived = typeof session.metadata?.archivedAt === 'number';
    const isRunning = sessionStatus.isConnected || session.active;

    // Stop — ends the run, leaves the session in the list. Only worth offering
    // while something is actually running.
    const [stoppingSession, performStop] = useHappyAction(async () => {
        await stopSessionProcess(session);
    });

    const stopSession = React.useCallback(() => {
        performStop();
    }, [performStop]);

    // Archive — files the session away into the archive screen. A session that
    // is still running is stopped on the way out: hiding a live agent would
    // leave it working where nobody can see it.
    const [archivingSession, performArchive] = useHappyAction(async () => {
        if (isRunning) {
            await stopSessionProcess(session);
        }
        sessionSetArchived(session.id, true);
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const unarchiveSession = React.useCallback(() => {
        sessionSetArchived(session.id, false);
    }, [session.id]);

    // Delete — irreversible, so it always goes through a confirmation.
    const [deletingSession, performDelete] = useHappyAction(async () => {
        if (isRunning) {
            await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);
            await sessionKill(session.id).catch(() => {});
        }
        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToDeleteSession'), false);
        }
        onAfterDelete?.();
    });

    const deleteSession = React.useCallback(() => {
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('sessionInfo.deleteSession'), style: 'destructive', onPress: performDelete },
            ],
        );
    }, [performDelete]);

    const togglePinned = React.useCallback(() => {
        sessionSetPinned(session.id, typeof session.metadata?.pinnedAt !== 'number');
    }, [session.id, session.metadata?.pinnedAt]);

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
            throw new HappyError(result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'), false);
        }
        navigateToSession(result.sessionId);
    });

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    const openDuplicateSheet = React.useCallback(() => {
        if (!canFork) return;
        Modal.show({
            component: DuplicateSheet,
            props: { sessionId: session.id },
        } as any);
    }, [canFork, session.id]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (resumeAvailability.canShowResume) {
            items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: resumeSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
            items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        items.push({
            id: 'pin',
            icon: typeof session.metadata?.pinnedAt === 'number' ? 'pin' : 'pin-outline',
            label: typeof session.metadata?.pinnedAt === 'number' ? t('sidebar.unpin') : t('sidebar.pin'),
            onPress: togglePinned,
        });

        if (isRunning) {
            items.push({ id: 'stop', icon: 'stop-circle-outline', label: t('sessionInfo.stopSession'), onPress: stopSession });
        }

        if (isArchived) {
            items.push({ id: 'unarchive', icon: 'archive-outline', label: t('sessionInfo.unarchiveSession'), onPress: unarchiveSession });
        } else {
            items.push({ id: 'archive', icon: 'archive-outline', label: t('sessionInfo.archiveSession'), onPress: archiveSession });
        }

        items.push({ id: 'delete', icon: 'trash-outline', label: t('sessionInfo.deleteSession'), onPress: deleteSession, destructive: true });

        return items;
    }, [
        archiveSession,
        canCopySessionMetadata,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        deleteSession,
        forkSource,
        forkSession,
        isArchived,
        isRunning,
        openDetails,
        openDuplicateSheet,
        stopSession,
        togglePinned,
        unarchiveSession,
        session.metadata?.pinnedAt,
        resumeAvailability.canShowResume,
        resumeSession,
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
        canArchive: !isArchived,
        canCopySessionMetadata,
        canStop: isRunning,
        deleteSession,
        deletingSession,
        isArchived,
        stopSession,
        stoppingSession,
        unarchiveSession,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        openDetails,
        openDuplicateSheet,
        togglePinned,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
    };
}

// Stands in for a session that storage does not have. A row can outlive its
// session — deleted while the list re-renders, or a fixture id in the layout
// sandbox — and the quick-actions hook still has to run to keep hook order
// stable. The stub only exists to be read and thrown away: the handler built
// from it is never handed out.
export const MISSING_SESSION: Session = {
    id: '',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    metadata: null,
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 0,
};

/**
 * Swipe-action helper for list rows, which hold a `SessionRowData` rather than
 * a full session. Resolves the session and hands back the archive pair, so a
 * row in the main list can file a session away and a row on the archive screen
 * can send it back — both going through the same logic as the menus.
 */
export function useSessionArchiveActions(sessionId: string) {
    const session = useSession(sessionId);
    const { archiveSession, archivingSession, unarchiveSession } = useSessionQuickActions(session ?? MISSING_SESSION, {});
    return {
        archiveSession,
        archivingSession,
        unarchiveSession,
        hasSession: session !== null,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile,
 * or undefined when the id has no session behind it.
 */
export function useSessionActionAlert(sessionId: string) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session ?? MISSING_SESSION, {});
    return session ? showActionAlert : undefined;
}
