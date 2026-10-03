import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, machineStopSession, sessionArchive, sessionKill, sessionSetAgentModes, forkAndSpawn, type ForkSource } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useLocalSetting, useMachine, useSetting } from '@/sync/storage';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta, UnsupportedPermissionModeError } from '@/sync/messageMeta';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { delay } from '@/utils/time';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionForkSource } from '@/utils/sessionFork';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { DuplicateSheet } from '@/components/DuplicateSheet';
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { isRigMetadata } from '@/sync/rig';

export interface SessionActionItem {
    id: SessionActionShortcutId;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    /**
     * Called on the press, before anything is asked of the machine.
     *
     * Archiving the chat you are reading has to move the screen off it first.
     * A kill that lands while the session is still the route takes the screen
     * apart around the user: the tab strip loses the checkout it was drawing
     * and collapses, the content falls back to "session deleted", and both come
     * back a moment later once the neighbouring tab is routed to. Moving first
     * makes the only visible change the one that was asked for — a tab leaving
     * the strip.
     *
     * The cost is that a press which then fails has still moved the screen. The
     * chat is alive and still in the strip, one tab away, and the failure says
     * so in its own words.
     */
    onBeforeArchive?: () => void;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
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

    // Older daemons do not publish resumeSupport and do not implement the
    // resume RPC. Capability presence is the compatibility check; the UI is
    // hidden instead of offering an action that the machine cannot execute.
    if (machine.metadata?.resumeSupport?.rpcAvailable !== true) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

type ResumeMode = { model?: string; permissionMode?: string };

/**
 * The model and permission mode a session starts again with: the ones its next
 * message would use.
 */
function resolveResumeMode(session: Session): ResumeMode {
    try {
        const modeMeta = resolveMessageModeMeta(session, storage.getState().settings);
        return { model: modeMeta.model ?? undefined, permissionMode: modeMeta.permissionMode };
    } catch (error) {
        if (error instanceof UnsupportedPermissionModeError) {
            // Refuse loudly instead of substituting a mode: swapping in a
            // default would silently change what the agent may do.
            throw new HappyError(error.message, false);
        }
        throw error;
    }
}

/** How long Restart keeps asking the machine to start the session again. */
const RESTART_RESUME_TIMEOUT_MS = 15_000;
const RESTART_RESUME_RETRY_MS = 500;
/** How long Restart waits to see a session that stopped itself go offline. */
const RESTART_OFFLINE_TIMEOUT_MS = 10_000;

/**
 * Stop a live session so that it can be started again.
 *
 * Archive's way of stopping a session — asking its own process to exit — is
 * not enough here. The daemon finds out only once the process has gone, and
 * until then it answers a resume as if the session were still running:
 * success, with nothing started, which would leave the session down. When the
 * daemon does the stopping itself, it marks the process as stopping first and
 * refuses a resume with an error until it has exited, so the resume that
 * follows can simply be retried.
 *
 * A daemon only knows the sessions that started while it was running, though,
 * and a CLI upgrade restarts it. A session older than its daemon is stopped the
 * way Archive stops it, and the resume waits for the server to see it offline.
 */
async function stopForRestart(session: Session, machineId: string): Promise<void> {
    const stopped = await machineStopSession(machineId, session.id);
    if (stopped.success) {
        return;
    }
    const killed = await sessionKill(session.id);
    if (killed.success) {
        await waitUntilOffline(session.id, RESTART_OFFLINE_TIMEOUT_MS);
        return;
    }
    // Nothing answered. A session that went offline in the meantime has
    // nothing left to stop, but one the server still sees running would get a
    // second copy next to it.
    if (storage.getState().sessions[session.id]?.active) {
        throw new HappyError(t('sessionInfo.restartSessionCouldNotStop'), false);
    }
}

async function waitUntilOffline(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (storage.getState().sessions[sessionId]?.active && Date.now() < deadline) {
        await delay(250);
    }
}

/**
 * Start a just-stopped session again. While its old process is still on the
 * way out, the daemon answers with an error instead of waiting for it, so keep
 * asking until it takes the session back.
 */
async function resumeOnceStopped(session: Session, machineId: string, mode: ResumeMode): Promise<void> {
    const deadline = Date.now() + RESTART_RESUME_TIMEOUT_MS;
    while (true) {
        const result = await machineResumeSession({ machineId, sessionId: session.id, ...mode });
        switch (result.type) {
            case 'success':
                return;
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                if (Date.now() >= deadline) {
                    throw new HappyError(result.errorMessage, false);
                }
                await delay(RESTART_RESUME_RETRY_MS);
        }
    }
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterCopySessionMetadata,
        onBeforeArchive,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const continuationExperimentsEnabled = useSetting('expResumeSession');
    const resumeAvailability = React.useMemo(
        () => getResumeAvailability(session, machine, sessionStatus.isConnected),
        [machine, session, sessionStatus.isConnected],
    );
    // Restart is offered for a live session that its machine could resume once
    // stopped. A session that has already stopped is offered Resume instead.
    const canRestart = React.useMemo(
        () => sessionStatus.isConnected && getResumeAvailability(session, machine, false).canResume,
        [machine, session, sessionStatus.isConnected],
    );

    // Fork eligibility — separate from resume because fork works on both
    // active AND inactive provider sessions. Fork/duplicate still use the
    // legacy rollout flag because resumeSupport does not prove that the daemon
    // implements the newer fork RPC.
    const forkSource = React.useMemo(() => getSessionForkSource(session), [
        session.id,
        session.metadata?.flavor,
        session.metadata?.machineId,
        session.metadata?.path,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
    const canFork = Boolean(
        continuationExperimentsEnabled
        && !isRigMetadata(session.metadata)
        && forkSource
        && machine
        && isMachineOnline(machine)
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

        const result = await machineResumeSession({
            machineId,
            sessionId: session.id,
            ...resolveResumeMode(session),
        });

        switch (result.type) {
            case 'success': {
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    sessionSetAgentModes(result.sessionId, { permissionMode: session.permissionMode });
                }
                // Model / effort picks survive resume on their own — they live
                // in the session's synced metadata (#1492).

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
        // Before the first await: the screen has to be off this chat while it is
        // still whole, not once the store has started dismantling it.
        onBeforeArchive?.();
        // Also before it. Archiving asks a machine to check a worktree, then to
        // kill the agent, and sometimes the server to retire the session after
        // that — seconds, during which the row the user just archived used to
        // sit in the list looking untouched. It leaves now, and the only thing
        // that brings it back is the archive not working.
        storage.getState().markArchiving(session.id);
        try {
            if (session.metadata?.bot) {
                const result = await sessionKill(session.id);
                if (!result.success) {
                    throw new HappyError(result.message || 'Connect to the bot’s machine to archive it.', false);
                }
                onAfterArchive?.();
                return;
            }
            await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

            // Try to kill the CLI process; if it's already dead, force-archive via server
            const killResult = await sessionKill(session.id);
            if (!killResult.success) {
                // Checked, where it used to be fire-and-forget: the row has
                // already left the list on the strength of this working, and a
                // fallback that fails quietly would leave a live chat hidden.
                const archiveResult = await sessionArchive(session.id);
                if (!archiveResult.success) {
                    throw new HappyError(archiveResult.message || t('sessionInfo.failedToArchiveSession'), false);
                }
            }
            onAfterArchive?.();
        } catch (error) {
            // Back into the list, where it still is as far as the machine is
            // concerned. The screen stays where the press put it: the user
            // moved on, and hauling them back to a chat they tried to close
            // would be a second surprise on top of the failure, which
            // useHappyAction is already reporting in words.
            storage.getState().unmarkArchiving(session.id);
            throw error;
        }
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    // Archive followed by Resume, without the parts of Archive that only suit
    // a session that is going away: the worktree cleanup, taking the row out
    // of the list, and moving the screen off the chat.
    const [restartingSession, performRestart] = useHappyAction(async () => {
        // Before anything is stopped, so a mode the resume would refuse cannot
        // leave the session down.
        const mode = resolveResumeMode(session);
        await stopForRestart(session, machineId);
        await resumeOnceStopped(session, machineId, mode);
        // No refresh, unlike Resume: the session keeps its id and its live
        // updates, while the server's stored copy can still say it is offline
        // for a few seconds, which would hide the row that just came back.
    });

    const restartSession = React.useCallback(() => {
        performRestart();
    }, [performRestart]);

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

        if (canRestart) {
            items.push({ id: 'restart', icon: 'refresh-outline', label: t('sessionInfo.restartSession'), onPress: restartSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
            items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        items.push({ id: 'archive', icon: 'archive-outline', label: t('session.archiveAction'), onPress: archiveSession, destructive: true });

        return items;
    }, [
        archiveSession,
        canCopySessionMetadata,
        canFork,
        canRestart,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSource,
        forkSession,
        openDetails,
        openDuplicateSheet,
        restartSession,
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
        Modal.alert(t('session.actionsTitle'), undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        archiveSession,
        archivingSession,
        canArchive: true,
        canCopySessionMetadata,
        canRestart,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        openDetails,
        openDuplicateSheet,
        restartSession,
        restartingSession,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile.
 */
/**
 * A session that is not in the store has no actions, but the hooks above still
 * have to run in the same order on every render — so a missing session is
 * handed this frozen stand-in and the caller drops the result. Without it
 * useSessionQuickActions dereferences null long before its callers reach the
 * `if (!session)` guard they already have.
 */
export const MISSING_SESSION: Session = Object.freeze({
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
});

export function useSessionActionAlert(sessionId: string, options: UseSessionQuickActionsOptions = {}) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session ?? MISSING_SESSION, options);
    return session ? showActionAlert : undefined;
}

/**
 * Archiving for a row that only has an id — the flat list's swipe.
 *
 * It used to call `sessionKill` on its own, which meant the swipe skipped the
 * worktree cleanup, the server-side fallback for an agent that is already
 * dead, and — since the row leaving the list on the press lives in the action
 * too — the whole point of this change.
 */
export function useSessionArchiveAction(sessionId: string) {
    const session = useSession(sessionId);
    const { archiveSession, archivingSession } = useSessionQuickActions(session ?? MISSING_SESSION);
    return { archiveSession, archivingSession };
}
