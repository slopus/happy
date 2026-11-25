import { getCrossAgentTarget } from '@/utils/crossAgentContinuation';
import { createCrossAgentContinuation } from '@/sync/crossAgentContinuation';
import * as React from 'react';
import { isRetiredSession } from '@/sync/retiredSessions';
import { createSessionContinuation } from '@/sync/sessionContinuation';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, sessionRestoreMetadata, sessionRegenerateTitle, sessionUpdateMetadata, forkAndSpawn, codexListRewindPoints, type ForkSource } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useMachine, useSetting } from '@/sync/storage';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isArchivedLifecycleState } from '@/utils/sessionLifecycle';
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
import { resolveSessionResumeAvailability } from '@/utils/sessionResumeAvailability';
import { getConversationRootSessionId, resolveConversationRootSessionId, resolveConversationSessionId } from '@/sync/conversationSession';
import { BulkSessionActionError, bulkArchiveSessions, bulkDeleteSessions, refreshConversationActionAuthority, resolveSessionsForBulkAction } from './bulkSessionActions';

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

export type SessionGroupActionFailure = {
    action: 'archive' | 'delete' | 'restore';
    message: string;
    completedIds: readonly string[];
    failedSessionId: string | null;
    pendingIds: readonly string[];
};

function isRegenerateTitleRpcUnavailable(message: string | undefined): boolean {
    return message === 'RPC call failed'
        || message === 'RPC method not available'
        || message === 'Method not found';
}

function getResumeAvailability(session: Session, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    if (isRetiredSession(session)) return { canResume: false, canShowResume: false, subtitle: '', message: '' };
    const availability = resolveSessionResumeAvailability({
        isConnected,
        hasMachineId: Boolean(session.metadata?.machineId),
        hasBackendResumeId: Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId),
        hasMachine: Boolean(machine),
        machineOnline: Boolean(machine && isMachineOnline(machine)),
        rpcAvailable: machine?.metadata?.resumeSupport?.rpcAvailable,
    });
    if (availability === 'hidden') {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    if (availability === 'missing-machine') {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (availability === 'missing-backend-id') {
        const message = t('sessionInfo.resumeSessionMissingBackendId');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (availability === 'wrong-machine') {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (availability === 'machine-offline') {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    if (availability === 'rpc-unavailable') {
        const message = t('sessionInfo.resumeSessionNeedsHappyAgent');
        return { canResume: false, canShowResume: true, subtitle: message, message };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

export function useSessionQuickActions(
    providedSession: Session,
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
    const renderSessions = storage.getState().sessions;
    const raw = renderSessions[providedSession.id] ?? providedSession;
    const needsRootResolution = Boolean(raw.metadata?.conversationRootSessionId || raw.metadata?.conversationActiveSessionId
        || raw.metadata?.conversationSwitch || raw.metadata?.conversationDeletePlan || raw.metadata?.continuationOfSessionId);
    const confirmedRootId = needsRootResolution ? resolveConversationRootSessionId(renderSessions, providedSession.id) : raw.id;
    const rootId = confirmedRootId ?? getConversationRootSessionId(providedSession);
    const rootSession = useSession(rootId);
    const executionSessionId = confirmedRootId ? renderSessions[confirmedRootId]?.metadata?.conversationActiveSessionId ?? confirmedRootId : null;
    const session = useSession(executionSessionId ?? providedSession.id) ?? providedSession;
    const canRetryConversationDelete = Boolean(rootSession?.metadata?.conversationDeletePlan);
    const executionReady = Boolean(executionSessionId && !canRetryConversationDelete && !rootSession?.metadata?.conversationSwitch);
    const requireExecutionSession = React.useCallback((actionRootId = rootId) => {
        const state = storage.getState();
        const id = resolveConversationSessionId(state.sessions, actionRootId);
        const current = id ? state.sessions[id] : undefined;
        if (!current || state.sessions[actionRootId]?.metadata?.conversationSwitch || state.sessions[actionRootId]?.metadata?.conversationDeletePlan) {
            throw new HappyError(t('session.agentSwitchUnavailable'), false);
        }
        return current;
    }, [rootId]);
    const [groupActionFailure, setGroupActionFailure] = React.useState<SessionGroupActionFailure | null>(null);
    const prepareLifecycleAction = React.useCallback(async (action: 'archive' | 'delete' | 'restore') => {
        setGroupActionFailure(null);
        try {
            return await refreshConversationActionAuthority(providedSession, { allowDeletePlan: action === 'delete',
                expectedRootId: confirmedRootId ?? providedSession.metadata?.conversationRootSessionId ?? null });
        } catch (error) {
            const message = error instanceof Error ? error.message : t('errors.unknownError');
            setGroupActionFailure({ action, message, completedIds: [], failedSessionId: null, pendingIds: [] });
            throw error instanceof HappyError ? error : new HappyError(message, false);
        }
    }, [providedSession, confirmedRootId]);
    const performConversationGroupAction = React.useCallback(async (action: 'archive' | 'delete', authorityRoot: Session) => {
        setGroupActionFailure(null);
        const root = storage.getState().sessions[authorityRoot.id];
        try {
            if (!root) throw new Error(t('session.agentSwitchUnavailable'));
            if (action === 'archive') await bulkArchiveSessions([root]);
            else await bulkDeleteSessions([root]);
        } catch (error) {
            const message = error instanceof Error ? error.message : t('errors.unknownError');
            setGroupActionFailure({ action, message,
                completedIds: error instanceof BulkSessionActionError ? error.completedIds : [],
                failedSessionId: error instanceof BulkSessionActionError ? error.failedSessionId : null,
                pendingIds: error instanceof BulkSessionActionError ? error.pendingIds : [],
            });
            // Reflect completed segments without claiming the whole conversation changed.
            await sync.refreshSessions().catch(() => {});
            throw new HappyError(message, false);
        }
    }, []);
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const expResumeSession = useSetting('expResumeSession');
    const sessionManagement = useSessionManagementPreferences([rootId], { prune: false });
    const sessionPinned = sessionManagement.isPinned(rootId);
    const resumeAvailability = React.useMemo(
        () => executionReady ? getResumeAvailability(session, machine, sessionStatus.isConnected)
            : { canResume: false, canShowResume: false, subtitle: '', message: t('session.agentSwitchUnavailable') },
        [executionReady, machine, session, sessionStatus.isConnected],
    );

    // Fork eligibility is separate from resume because fork works on both
    // active and inactive provider sessions. Fork/duplicate retain the legacy
    // experiment switch; resume is now a standard recovery action.
    const forkSource = React.useMemo(() => getSessionForkSource(session), [
        session.id,
        session.metadata?.flavor,
        session.metadata?.machineId,
        session.metadata?.path,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
    const canFork = Boolean(
        executionReady
        && expResumeSession
        && forkSource
        && machine
        && isMachineOnline(machine),
    );
    const canRegenerateTitle = executionReady && canRegenerateSessionTitle(session);
    const crossAgentTarget = executionReady ? getCrossAgentTarget(session, machine) : null;
    const [continuingWithAgent, performContinueWithAgent] = useHappyAction(async () => {
        if (!crossAgentTarget) throw new HappyError(t('session.crossAgentUnavailable'), false);
        const current = requireExecutionSession();
        const id = await createCrossAgentContinuation(current.id, crossAgentTarget);
        hapticsSuccess(); navigateToSession(id);
    });
    const continueWithAgent = React.useCallback(() => { performContinueWithAgent(); }, [performContinueWithAgent]);


    const openDetails = React.useCallback(() => {
        router.push(`/session/${rootId}/info`);
    }, [router, rootId]);

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
        sessionManagement.togglePinned(rootId);
    }, [rootId, sessionManagement]);

    const resumeOriginalSession = React.useCallback(async (actionRootId = rootId) => {
        // Restore awaits metadata and refresh first. Another device may have
        // reconnected the worker during that time; never restart it using the
        // availability captured when the action was rendered.
        const currentState = storage.getState();
        const currentSession = requireExecutionSession(actionRootId);
        if (currentSession.presence === 'online' && !isArchivedLifecycleState(currentSession.metadata?.lifecycleState)) return;
        const currentMachineId = currentSession.metadata?.machineId ?? '';
        const availability = getResumeAvailability(currentSession, currentState.machines[currentMachineId], false);
        if (!availability.canResume) {
            throw new HappyError(availability.message, false);
        }

        const modeMeta = resolveMessageModeMeta(currentSession, currentState.settings);
        const result = await machineResumeSession({
            machineId: currentMachineId,
            sessionId: currentSession.id,
            agent: currentSession.metadata?.flavor ?? 'claude',
            codexMagpieConnection: currentSession.metadata?.codexMagpieConnection,
            model: modeMeta.model ?? undefined,
            permissionMode: modeMeta.permissionMode,
            effort: modeMeta.effort,
        });

        switch (result.type) {
            case 'success': {
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (currentSession.permissionMode) {
                    storage.getState().updateSessionPermissionMode(result.sessionId, currentSession.permissionMode);
                }
                if (currentSession.modelMode) {
                    storage.getState().updateSessionModelMode(result.sessionId, currentSession.modelMode);
                }
                if (currentSession.effortLevel !== undefined) {
                    storage.getState().updateSessionEffortLevel(result.sessionId, currentSession.effortLevel);
                }

                navigateToSession(actionRootId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    }, [navigateToSession, requireExecutionSession, rootId]);

    const [resumingSession, performResume] = useHappyAction(resumeOriginalSession);

    const canContinue = executionReady && !isRetiredSession(session) && (!sessionStatus.isConnected || sessionStatus.state === 'failed' || Boolean(session.metadata?.continuedBySessionId));
    const [continuingSession, continueSession] = useHappyAction(async () => {
        try {
            const id = await createSessionContinuation(requireExecutionSession().id);
            navigateToSession(id);
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const translated = message === 'continuation-machine-offline' ? t('session.continueOffline')
                : message === 'continuation-outcome-unknown' ? t('session.continueUnknown')
                : message === 'continuation-history-unavailable' ? t('session.continueHistoryError')
                : message === 'continuation-hydration-failed' ? t('session.continueHydration')
                : message.startsWith('continuation-') ? t('session.continueMissing') : message;
            throw new HappyError(translated || t('errors.unknownError'), false);
        }
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        const authority = await prepareLifecycleAction('archive');
        if (!authority.grouped) {
            const current = authority.current!;
            await maybeCleanupWorktree(current.id, current.metadata?.path, current.metadata?.machineId);
        }
        // Shared lifecycle operations recheck authority after optional worktree UI.
        await performConversationGroupAction('archive', authority.root);
        await sync.refreshSessions();
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    const [restoringSession, performRestore] = useHappyAction(async () => {
        const authority = await prepareLifecycleAction('restore');
        const original = authority.current!;
        const originallyConnected = original.presence === 'online' && !isArchivedLifecycleState(original.metadata?.lifecycleState);
        const resumeAtStart = getResumeAvailability(original,
            storage.getState().machines[original.metadata?.machineId ?? ''], originallyConnected).canResume;
        // Keep the lifecycle gate closed while the daemon captures its resume
        // cursor. Clearing it first lets another open page submit queued input
        // before the replacement worker has established its history boundary.
        await sync.refreshSessions();
        let group: Session[] | null = null;
        if (authority.grouped) {
            setGroupActionFailure(null);
            try { group = await resolveSessionsForBulkAction([storage.getState().sessions[authority.root.id] ?? authority.root]); }
            catch (error) {
                const message = error instanceof Error ? error.message : t('errors.unknownError');
                setGroupActionFailure({ action: 'restore', message, completedIds: [], failedSessionId: null, pendingIds: [] });
                throw new HappyError(message, false);
            }
        }
        const current = requireExecutionSession(authority.root.id);
        if (current.id !== authority.current?.id) throw new HappyError(t('session.agentSwitchChanged'), false);
        const currentMachineId = current.metadata?.machineId ?? '';
        const connected = current.presence === 'online' && !isArchivedLifecycleState(current.metadata?.lifecycleState);
        const availability = getResumeAvailability(current, storage.getState().machines[currentMachineId], connected);
        if (resumeAtStart || availability.canResume) {
            await resumeOriginalSession(authority.root.id);
        }
        // Resume refreshes the worker metadata. Do not write the object from
        // the archived render back over its new PID, capabilities or cursor.
        if (group) {
            setGroupActionFailure(null);
            const completedIds: string[] = [];
            for (const [index, member] of group.entries()) {
                try {
                    const latest = storage.getState().sessions[member.id];
                    if (!latest) throw new Error(t('errors.sessionDeleted'));
                    await sessionRestoreMetadata(latest);
                    completedIds.push(member.id);
                } catch (error) {
                    const message = error instanceof Error ? error.message : t('errors.unknownError');
                    setGroupActionFailure({ action: 'restore', message, completedIds, failedSessionId: member.id,
                        pendingIds: group.slice(index + 1).map(next => next.id) });
                    throw new HappyError(message, false);
                }
            }
        } else {
            const currentSession = requireExecutionSession(authority.root.id);
            await sessionRestoreMetadata(currentSession);
        }
        await sync.refreshSessions();
        hapticsSuccess();
    });

    const restoreSession = React.useCallback(() => {
        performRestore();
    }, [performRestore]);

    const updateSessionTitle = React.useCallback(async (nextTitle: string) => {
        const titleSession = storage.getState().sessions[rootId];
        if (!titleSession?.metadata || getConversationRootSessionId(titleSession) !== rootId) {
            throw new HappyError(t('sessionInfo.renameSessionMissingMetadata'), false);
        }

        const trimmedTitle = nextTitle.trim();
        if (!trimmedTitle || trimmedTitle === getSessionName(titleSession)) {
            return;
        }

        await sessionUpdateMetadata(
            rootId,
            titleSession.metadata,
            titleSession.metadataVersion,
            metadata => ({
                ...metadata,
                summary: {
                    text: trimmedTitle,
                    updatedAt: Date.now(),
                },
            }),
        );
    }, [rootId]);

    const [renamingFromPrompt, performRename] = useHappyAction(async () => {
        const titleSession = storage.getState().sessions[rootId];
        if (!titleSession?.metadata || getConversationRootSessionId(titleSession) !== rootId) {
            throw new HappyError(t('sessionInfo.renameSessionMissingMetadata'), false);
        }

        const currentTitle = getSessionName(titleSession);
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
        const current = requireExecutionSession();
        if (!current.metadata || !sessionStatus.isConnected) {
            throw new HappyError(t('sessionInfo.regenerateTitleUnavailable'), false);
        }
        if (!canRegenerateTitle) {
            throw new HappyError(t('sessionInfo.regenerateTitleRequiresUpdatedCli'), false);
        }

        await sync.ensureMessagesLoaded(current.id);
        if (requireExecutionSession().id !== current.id) throw new HappyError(t('session.agentSwitchChanged'), false);
        const messages = storage.getState().sessionMessages[current.id]?.messages ?? [];
        const transcript = buildSessionTitleTranscript(messages);
        if (!transcript) {
            throw new HappyError(t('sessionInfo.regenerateTitleNoMessages'), false);
        }

        const result = await sessionRegenerateTitle(current.id, {
            transcript,
            currentTitle: storage.getState().sessions[rootId]?.metadata?.summary?.text ?? null,
            projectPath: current.metadata.path ?? null,
            model: current.modelMode ?? current.metadata.currentModelCode ?? null,
            effort: current.effortLevel ?? current.metadata.currentThoughtLevelCode ?? null,
        });
        if (!result.success) {
            const message = isRegenerateTitleRpcUnavailable(result.message)
                ? t('sessionInfo.regenerateTitleRequiresUpdatedCli')
                : result.message || t('sessionInfo.regenerateTitleFailed');
            throw new HappyError(message, false);
        }

        if (current.id !== rootId) await updateSessionTitle(result.title);
        await sync.refreshSessions();
        hapticsSuccess();
    });

    const regenerateTitle = React.useCallback(() => {
        performRegenerateTitle();
    }, [performRegenerateTitle]);

    // Permanently delete a session. If it is still active, first try to stop
    // the CLI process so the server accepts the delete.
    const [deletingSession, performDelete] = useHappyAction(async () => {
        const authority = await prepareLifecycleAction('delete');
        if (!authority.grouped) {
            const current = authority.current!;
            await maybeCleanupWorktree(current.id, current.metadata?.path, current.metadata?.machineId);
        }
        await performConversationGroupAction('delete', authority.root);
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
                sourceSessionId: forkSource.sessionId,
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
                continueWithAgent: continuingWithAgent ? t('session.crossAgentCreating') : crossAgentTarget === 'claude' ? t('session.continueWithClaude') : t('session.continueWithCodex'),
                continueFresh: continuingSession ? t('session.continueCreating') : session.metadata?.continuedBySessionId ? t('session.continueOpen') : t('session.continueFresh'),
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
                continueSession,
                continueWithAgent,
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
            canContinue,
            canContinueWithAgent: !!crossAgentTarget,
            canRegenerateTitle,
            canFork,
            canCopySessionMetadata,
            sessionPinned,
            sessionActive: !canRetryConversationDelete && !sessionArchived,
            sessionArchived: !canRetryConversationDelete && sessionArchived,
            canSelect: Boolean(onSelectSession),
        });
    }, [
        crossAgentTarget,
        continuingWithAgent,
        continueWithAgent,
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
        canContinue,
        canRetryConversationDelete,
        continueSession,
        continuingSession,
        session.metadata?.continuedBySessionId,
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
        groupActionFailure,
        canRetryConversationDelete,
        crossAgentTarget,
        continuingWithAgent,
        continueWithAgent,
        canContinue,
        continueSession,
        continuingSession,
        showActionAlert,
        archiveSession,
        archivingSession,
        canArchive: !canRetryConversationDelete && session.active,
        canDelete: true,
        deleteSession,
        // For callers that already presented their own local confirmation.
        confirmDeleteSession: performDelete,
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
