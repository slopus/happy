import { prepareConversationSwitch, reserveConversationSwitch, releaseConversationSwitchReservation, claimConversationSwitch, commitConversationSwitch, releaseConversationSwitch, type ConversationSwitch, type ConversationSwitchReservation } from '@/sync/conversationSwitch';
import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { portableNativeSourceIdentity } from '@slopus/happy-wire';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync, type LocalMessageQueueReceipt } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { machineSpawnNewSession, machineSpawnConversationSession, machineCancelConversationLaunch, type SpawnSessionResult } from '@/sync/ops';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import type { Machine } from '@/sync/storageTypes';
import type { NewSessionAgentType } from '@/sync/persistence';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { organizeSession } from '@/sync/sidebarOrganization';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { traceStartup } from '@/sync/sessionStartupTrace';
import { sessionStartupTraceRuntime, type WebStartupTraceHandle } from '@/sync/sessionStartupTraceRuntime';
import { markSessionCriticalPathHydrationRetry } from '@/sync/sessionCriticalPathProbeBridge';
import { attachSessionContinuationContext, prepareSessionContinuationContext, buildPortableContextPreview, assertPortableContextSourceScope, type PreparedSessionContinuationContext } from '@/sync/sessionContextHandoff';

type NativeResume = Extract<SpawnSessionResult, { type: 'success' }>['nativeResume'];

export interface SpawnSessionArgs {
    continueInCurrentConversation?: boolean;
    /** Internal immutable reservation; never contains a client-selected native ID. */
    conversationReservation?: ConversationSwitchReservation;
    machineId: string;
    machine: Machine;
    /** Working directory on the machine; null/empty falls back to the home dir (~). */
    path: string | null;
    agent: NewSessionAgentType;
    /** Existing worktree absolute path, or null/'__none__' for no worktree. */
    worktreeKey: string | null;
    /** Per-session mode overrides selected before the first message. */
    permissionMode?: string | null;
    modelMode?: string | null;
    effortLevel?: string | null;
    fastMode?: boolean;
    discussing?: boolean;
    expectedCodexAccountProfileId?: string | null;
    magpieModel?: string;
    /** Initial prompt to send into the freshly spawned session. */
    prompt: string;
    /** Image attachments to send with the initial message (claude-only). */
    images?: AttachmentPreview[];
    /** Extra environment passed to daemon-spawned agent process. */
    environmentVariables?: Record<string, string>;
    /** Optional sidebar List that should own the newly created session. */
    sidebarListId?: string | null;
    /** Carry complete, retrievable history when explicitly changing Agent/connection. */
    continuationSourceSessionId?: string;
    /** Private, account-scoped role-config context; never a target model override. */
    roleConfigurationId?: string;
}

export type SpawnSessionCoreResult =
    | { type: 'success'; sessionId: string; nativeResume?: NativeResume }
    | { type: 'cancelled' }
    | { type: 'error'; message: string; sessionId?: string; notDispatched?: boolean; conversationCancelled?: true };

type PendingHydration = {
    sessionId: string;
    args: SpawnSessionArgs;
    trace: SessionStartupTraceContext;
    retrying: boolean;
    queued: boolean;
    receipt?: LocalMessageQueueReceipt;
    configured: boolean;
    handoff?: { sourceId: string; context?: PreparedSessionContinuationContext; coverage?: NonNullable<NativeResume>['coverage']; nativeResume?: NativeResume; attached: boolean };
    onQueued?: () => void;
    conversation?: ConversationSwitch & { claimed?: boolean; committed?: boolean; sendingStarted?: boolean };
};

type PendingLaunch = {
    args: SpawnSessionArgs; approvedNewDirectoryCreation: boolean; trace: SessionStartupTraceContext;
    conversation?: ConversationSwitchReservation; reserved?: boolean; retrying: boolean; onQueued?: () => void;
    handoff?: PendingHydration['handoff'];
    everOutcomeUnknown?: boolean;
};

type SessionStartupTraceContext = {
    traceId: string;
    startedAt: number;
    runtimeHandle: WebStartupTraceHandle;
    machineId: string;
    emittedStages: Set<'web.session.hydrated' | 'web.first_message.queued' | 'web.session.navigated'>;
};

function safelyTraceStartup(event: Parameters<typeof traceStartup>[0]): void {
    try {
        traceStartup(event);
    } catch {
        // Startup observability is best-effort and must never affect navigation.
    }
}

function runtimeTimestamp(): number {
    try {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
    } catch {
        // Date.now remains available in restricted web runtimes.
    }
    return Date.now();
}

function traceWebStartupStage(
    trace: SessionStartupTraceContext | undefined,
    stage: 'web.session.hydrated' | 'web.first_message.queued' | 'web.session.navigated',
    sessionId: string,
    outcome: 'success' | 'error' = 'success',
    errorCode?: string,
): void {
    if (!trace) return;
    if (outcome === 'success') {
        if (trace.emittedStages.has(stage)) return;
        trace.emittedStages.add(stage);
    }
    const timestamp = Date.now();
    safelyTraceStartup({
        traceId: trace.traceId,
        stage,
        timestamp,
        duration: timestamp - trace.startedAt,
        outcome,
        sessionId,
        machineId: trace.machineId,
        ...(errorCode ? { errorCode } : {}),
    });
}

export function configureSpawnedSession(sessionId: string, args: Pick<SpawnSessionArgs, 'permissionMode' | 'modelMode' | 'effortLevel' | 'fastMode' | 'sidebarListId'>): void {
    const sessionStorage = storage.getState();
    if (args.permissionMode !== undefined) {
        sessionStorage.updateSessionPermissionMode(sessionId, args.permissionMode);
    }
    if (args.modelMode !== undefined) {
        sessionStorage.updateSessionModelMode(sessionId, args.modelMode);
    }
    if (args.effortLevel !== undefined) {
        sessionStorage.updateSessionEffortLevel(sessionId, args.effortLevel);
    }
    if (args.fastMode !== undefined) {
        sessionStorage.updateSessionFastMode(sessionId, args.fastMode);
    }
    if (args.sidebarListId) {
        sync.applySettings({
            sidebarOrganization: organizeSession(
                sessionStorage.settings.sidebarOrganization,
                sessionId,
                { listId: args.sidebarListId, tagIds: [] },
            ),
        });
    }
}

/**
 * Inline session spawn used by the compose-first home. The non-navigating core
 * resolves/spawns/configures a session, while `spawn` preserves the existing
 * send-once then navigate behavior for current callers.
 */
export function useSpawnSession() {
    const navigateToSession = useNavigateToSession();
    const [sending, setSending] = React.useState(false);
    const [hydrationError, setHydrationError] = React.useState<{ sessionId: string } | null>(null);
    const pendingHydration = React.useRef<PendingHydration | null>(null);
    const pendingLaunch = React.useRef<PendingLaunch | null>(null);
    const sendingOperations = React.useRef(0);
    const spawningRef = React.useRef(false);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            pendingHydration.current = null;
            pendingLaunch.current = null;
        };
    }, []);

    const beginSending = React.useCallback(() => {
        sendingOperations.current += 1;
        if (mountedRef.current && sendingOperations.current === 1) setSending(true);
    }, []);
    const endSending = React.useCallback(() => {
        sendingOperations.current = Math.max(0, sendingOperations.current - 1);
        if (mountedRef.current && sendingOperations.current === 0) setSending(false);
    }, []);

    const spawnSession = React.useCallback(async (
        args: SpawnSessionArgs,
        approvedNewDirectoryCreation: boolean = false,
        startupTrace?: SessionStartupTraceContext,
        onRegistered?: (sessionId: string, nativeResume?: NativeResume) => void,
    ): Promise<SpawnSessionCoreResult> => {
        if (!mountedRef.current) return { type: 'cancelled' };
        if (args.continueInCurrentConversation && !args.conversationReservation) return { type: 'error', message: 'conversation-reservation-required', notDispatched: true };
        const { machineId, machine, path, agent, worktreeKey, environmentVariables } = args;
        if (!isMachineOnline(machine)) {
            const message = t('newSession.machineOffline');
            Modal.alert(t('common.error'), message);
            return { type: 'error', message, notDispatched: true };
        }

        beginSending();
        try {
            const pathToUse = (path ?? '').trim() || '~';
            const absolutePath = resolveAbsolutePath(pathToUse, machine.metadata?.homeDir);

            // Existing worktree → spawn directly in it. Worktree creation remains
            // owned by /new and is not supported by this straightforward core.
            const spawnDirectory = (worktreeKey && worktreeKey !== '__none__' && worktreeKey !== '__new__')
                ? worktreeKey
                : absolutePath;

            const runSpawn = async (approved: boolean): Promise<SpawnSessionCoreResult> => {
                const result = args.continueInCurrentConversation && args.conversationReservation
                    ? await machineSpawnConversationSession({ machineId, rootSessionId: args.conversationReservation.rootId,
                        sourceSessionId: args.conversationReservation.sourceId, requestId: args.conversationReservation.requestId,
                        targetAgent: agent, expectedCodexAccountProfileId: args.expectedCodexAccountProfileId,
                        ...(args.magpieModel ? { magpieModel: args.magpieModel } : {}),
                        ...(startupTrace ? { traceId: startupTrace.traceId } : {}),
                    })
                    : await machineSpawnNewSession({
                    machineId,
                    directory: spawnDirectory,
                    approvedNewDirectoryCreation: approved,
                    agent,
                    environmentVariables,
                    expectedCodexAccountProfileId: args.expectedCodexAccountProfileId,
                    ...(args.magpieModel ? { magpieModel: args.magpieModel } : {}),
                    ...(startupTrace ? { traceId: startupTrace.traceId } : {}),
                });

                switch (result.type) {
                    case 'success': {
                        if (!mountedRef.current) return { type: 'cancelled' };
                        onRegistered?.(result.sessionId, result.nativeResume);
                        const hydrated = await ensureSessionHydratedWithRetry(result.sessionId);
                        if (!hydrated) {
                            return {
                                type: 'error',
                                message: 'newSession.sessionHydrationFailed',
                                sessionId: result.sessionId,
                            };
                        }
                        traceWebStartupStage(startupTrace, 'web.session.hydrated', result.sessionId);
                        if (!mountedRef.current) return { type: 'cancelled' };
                        configureSpawnedSession(result.sessionId, args);
                        return { type: 'success', sessionId: result.sessionId, nativeResume: result.nativeResume };
                    }
                    case 'requestToApproveDirectoryCreation': {
                        const approved = await Modal.confirm(
                            t('composeHome.createDirectoryTitle'),
                            t('composeHome.createDirectoryMessage', { path: result.directory }),
                            { cancelText: t('common.cancel'), confirmText: t('common.create') },
                        );
                        return approved && mountedRef.current ? runSpawn(true) : { type: 'cancelled' };
                    }
                    case 'error':
                        Modal.alert(t('common.error'), result.errorMessage);
                        return { type: 'error', message: result.errorMessage, ...('notDispatched' in result && result.notDispatched ? { notDispatched: true } : {}),
                            ...('conversationCancelled' in result && result.conversationCancelled ? { conversationCancelled: true } : {}) };
                }
            };

            return await runSpawn(approvedNewDirectoryCreation);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start session';
            if (mountedRef.current) Modal.alert(t('common.error'), message);
            return { type: 'error', message };
        } finally {
            endSending();
        }
    }, [beginSending, endSending]);

    const cancelUnsentCandidate = React.useCallback(async (pending: PendingHydration): Promise<void> => {
        if (!pending.conversation || pending.queued || pending.conversation.sendingStarted) throw new Error('The candidate delivery outcome must be recovered before cancellation.');
        if (!pending.conversation.claimed) {
            const reservation = storage.getState().sessions?.[pending.conversation.rootId]?.metadata?.conversationSwitch;
            if (reservation?.id === pending.conversation.requestId && reservation.sourceSessionId === pending.conversation.sourceId
                && (reservation.targetSessionId === undefined || reservation.targetSessionId === pending.sessionId)) {
                pending.conversation.claimed = reservation.targetSessionId === pending.sessionId;
            } else await reserveConversationSwitch(pending.conversation);
        }
        const result = await machineCancelConversationLaunch({ machineId: pending.args.machineId,
            rootSessionId: pending.conversation.rootId, sourceSessionId: pending.conversation.sourceId,
            requestId: pending.conversation.requestId });
        if (!result.success || result.cancelled !== true || (result.targetSessionId && result.targetSessionId !== pending.sessionId)) throw new Error('The old candidate could not be cancelled safely.');
        if (pending.conversation.claimed) await releaseConversationSwitch(pending.conversation);
        else await releaseConversationSwitchReservation(pending.conversation);
        if (pendingHydration.current === pending) pendingHydration.current = null;
        pendingLaunch.current = null;
        if (mountedRef.current) setHydrationError(null);
    }, []);

    const finishPending = React.useCallback(async (pending: PendingHydration): Promise<boolean> => {
        if (pending.handoff?.context && !pending.queued && !pending.conversation?.sendingStarted) {
            try { pending.handoff.context.assertIdentityCurrent?.(); }
            catch (error) { if (pending.conversation) await cancelUnsentCandidate(pending); throw error; }
            try { pending.handoff.context.assertCurrent?.(); }
            catch {
                // A failed pre-send attempt may rebuild an archive for newly
                // acknowledged history. A native restore keeps its epoch fence.
                pending.handoff.context = undefined;
                pending.handoff.attached = false;
            }
        }
        if (pending.handoff && !pending.handoff.attached) {
            // Native restoration retires the previous wrapper first. Snapshot
            // afterwards so its final acknowledged events belong to this archive.
            if (!pending.handoff.context) {
                const prepared = await prepareSessionContinuationContext(pending.handoff.sourceId);
                const native = pending.handoff.nativeResume;
                if (native) {
                    const sources = native.contextSources;
                    const heads = prepared.archive.snapshot.heads;
                    if (!sources?.length || sources.some(source => {
                        const head = heads.find(head => head.sessionId === source.sessionId);
                        const metadata = storage.getState().sessions?.[source.sessionId]?.metadata;
                        return !head || !metadata || portableNativeSourceIdentity(metadata) !== source.identity;
                    })) {
                        await cancelUnsentCandidate(pending);
                        throw new Error('native-source-scope-changed-requires-fresh-session');
                    }
                }
                if (native && native.contextEpoch !== undefined) {
                    // Frozen prefixes can belong to independent chats whose
                    // live parent has since cleared. Only this restored native's
                    // proven logical chain participates in its epoch check.
                    const logicalIds = new Set(native.contextSources?.map(source => source.sessionId));
                    const resetHead = prepared.archive.snapshot.heads.find(head => logicalIds.has(head.sessionId)
                        && storage.getState().sessions?.[head.sessionId]?.metadata?.portableContextBoundary);
                    const reset = resetHead ? { sessionId: resetHead.sessionId,
                        boundaryId: storage.getState().sessions[resetHead.sessionId].metadata!.portableContextBoundary!.id } : null;
                    if (JSON.stringify(reset) !== JSON.stringify(native.contextEpoch)) {
                        await cancelUnsentCandidate(pending);
                        throw new Error('native-context-reset-requires-fresh-session');
                    }
                }
                pending.handoff.context = pending.handoff.coverage?.length
                    ? { ...prepared, context: buildPortableContextPreview(prepared.archive.snapshot, pending.handoff.coverage) }
                    : prepared;
            }
            await attachSessionContinuationContext(pending.sessionId, pending.handoff.sourceId, pending.handoff.context);
            pending.handoff.attached = true;
        }
        if (!mountedRef.current || pendingHydration.current !== pending) return false;
        if (pending.conversation && !pending.conversation.claimed) {
            await claimConversationSwitch(pending.conversation);
            pending.conversation.claimed = true;
        }
        if (!mountedRef.current || pendingHydration.current !== pending) {
            if (pending.conversation?.claimed && !pending.conversation.sendingStarted) await releaseConversationSwitch(pending.conversation);
            return false;
        }
        if (!pending.queued) {
            const attachments = pending.args.images?.length ? pending.args.images : undefined;
            if (pending.args.prompt || attachments) {
                try {
                    if (pending.handoff?.context) await pending.handoff.context.verifyCurrent?.();
                    if (!mountedRef.current || pendingHydration.current !== pending) {
                        if (pending.conversation?.claimed && !pending.conversation.sendingStarted) await releaseConversationSwitch(pending.conversation);
                        return false;
                    }
                    const isCurrent = () => {
                        if (!mountedRef.current || pendingHydration.current !== pending) return false;
                        try { pending.handoff?.context?.assertCurrent?.(); return true; } catch { return false; }
                    };
                    if (pending.conversation) pending.conversation.sendingStarted = true;
                    let receipt: LocalMessageQueueReceipt;
                    try {
                        receipt = await sync.sendMessage(pending.sessionId, pending.args.prompt, { source: 'new_session', attachments,
                            ...(pending.handoff ? { isCurrent } : {}),
                            ...(pending.conversation ? { conversationSwitchRequestId: pending.conversation.requestId } : {}),
                        });
                    } catch (error) {
                        // sendMessage throws only before its atomic outbox commit.
                        // A rejected upload/encryption must not strand the source.
                        if (pending.conversation) {
                            pending.conversation.claimed = false;
                            pending.conversation.sendingStarted = false;
                            await releaseConversationSwitch(pending.conversation);
                        }
                        throw error;
                    }
                    if (receipt?.type !== 'queued' || receipt.sessionId !== pending.sessionId || !receipt.localIds.length) {
                        throw new Error('local-message-queue-unconfirmed');
                    }
                    pending.queued = true;
                    pending.receipt = receipt;
                    traceWebStartupStage(pending.trace, 'web.first_message.queued', pending.sessionId);
                } catch (error) {
                    traceWebStartupStage(pending.trace, 'web.first_message.queued', pending.sessionId, 'error', 'local-message-queue-failed');
                    throw error;
                }
            } else pending.queued = true;
        }
        if (pending.receipt && !await sync.awaitLocalMessageProjection(pending.sessionId, pending.receipt.localIds, pending.receipt)) {
            throw new Error('local-message-projection-unconfirmed');
        }
        if (pending.conversation) await sync.awaitConversationHandoffDelivery(pending.sessionId, pending.conversation.sourceId);
        if (!mountedRef.current || pendingHydration.current !== pending) return false;
        if (pending.conversation && !pending.conversation.committed) {
            // Snapshot cleanup precedes the active-pointer write, which remounts the view.
            pending.onQueued?.();
            pending.onQueued = undefined;
            await commitConversationSwitch(pending.conversation);
            pending.conversation.committed = true;
        }
        // The route may synchronously dismiss/unmount the compose component.
        // Transfer or clear its accepted draft before invoking navigation.
        pending.onQueued?.();
        if (!pending.conversation) navigateToSession(pending.sessionId);
        traceWebStartupStage(pending.trace, 'web.session.navigated', pending.sessionId);
        pendingHydration.current = null;
        if (mountedRef.current) setHydrationError(null);
        return true;
    }, [cancelUnsentCandidate, navigateToSession]);

    const finishLaunch = React.useCallback(async (launch: PendingLaunch): Promise<boolean> => {
        if (launch.conversation && !launch.reserved) {
            await reserveConversationSwitch(launch.conversation);
            launch.reserved = true;
        }
        if (!mountedRef.current) {
            if (launch.conversation && launch.reserved) await releaseConversationSwitchReservation(launch.conversation);
            return false;
        }
        const args = launch.args;
        const result = await spawnSession(args, launch.approvedNewDirectoryCreation, launch.trace, (sessionId, nativeResume) => {
            sessionStartupTraceRuntime.bindSession(launch.trace.runtimeHandle, sessionId);
            pendingHydration.current = { sessionId, args, trace: launch.trace, retrying: false, queued: false, configured: false,
                ...(args.continuationSourceSessionId ? { handoff: launch.handoff ?? { sourceId: args.continuationSourceSessionId, attached: false,
                    ...(nativeResume ? { coverage: nativeResume.coverage, nativeResume } : {}) } } : {}),
                onQueued: launch.onQueued,
                ...(launch.conversation ? { conversation: { ...launch.conversation, targetId: sessionId } } : {}),
            };
            pendingLaunch.current = null;
        });
        if (!mountedRef.current) return false;
        if (result.type !== 'success') {
            const pending = pendingHydration.current;
            if (!pending && launch.conversation && result.type === 'error' && !result.notDispatched) launch.everOutcomeUnknown = true;
            if (!pending && result.type === 'error' && result.notDispatched && (!launch.everOutcomeUnknown || result.conversationCancelled)) {
                if (launch.conversation && launch.reserved) await releaseConversationSwitchReservation(launch.conversation);
                pendingLaunch.current = null;
                setHydrationError(null);
            } else if (!pending && !launch.conversation) {
                pendingLaunch.current = null;
            } else setHydrationError({ sessionId: pending?.sessionId ?? launch.conversation!.rootId });
            return false;
        }
        pendingLaunch.current = null;
        const pending = pendingHydration.current!;
        pending.configured = true;
        return finishPending(pending);
    }, [finishPending, spawnSession]);

    // Returns true when a session was created (so callers can clear their input).
    const spawn = React.useCallback(async (
        args: SpawnSessionArgs,
        approvedNewDirectoryCreation: boolean = false,
        onQueued?: () => void,
    ): Promise<boolean> => {
        if (!mountedRef.current || pendingHydration.current || pendingLaunch.current || spawningRef.current) {
            return false;
        }
        spawningRef.current = true;
        const startedAt = Date.now();
        const traceId = randomUUID();
        const startupTrace: SessionStartupTraceContext = {
            traceId,
            startedAt,
            runtimeHandle: sessionStartupTraceRuntime.begin(traceId, runtimeTimestamp()),
            machineId: args.machineId,
            emittedStages: new Set(),
        };
        safelyTraceStartup({
            traceId: startupTrace.traceId,
            stage: 'web.spawn.clicked',
            timestamp: startedAt,
            outcome: 'success',
            machineId: startupTrace.machineId,
        });
        beginSending();
        try {
            if (args.continueInCurrentConversation && !args.continuationSourceSessionId) throw new Error('conversation-source-required');
            const conversationRootId = args.continueInCurrentConversation
                ? await prepareConversationSwitch(args.continuationSourceSessionId!) : undefined;
            if (args.continuationSourceSessionId) assertPortableContextSourceScope(storage.getState().sessions?.[args.continuationSourceSessionId]?.metadata);
            // Independent new sessions retain their existing pre-spawn snapshot
            // behavior. In-chat native restores collect after retiring writers.
            const handoff = !args.continueInCurrentConversation && args.continuationSourceSessionId
                ? { sourceId: args.continuationSourceSessionId, context: await prepareSessionContinuationContext(args.continuationSourceSessionId), attached: false }
                : undefined;
            if (!mountedRef.current) return false;
            const conversation = conversationRootId ? { rootId: conversationRootId, sourceId: args.continuationSourceSessionId!, requestId: traceId } : undefined;
            const launch: PendingLaunch = { args: { ...args, ...(conversation ? { conversationReservation: conversation } : {}) },
                approvedNewDirectoryCreation, trace: startupTrace, retrying: false, onQueued, conversation, handoff };
            pendingLaunch.current = launch;
            return await finishLaunch(launch);
        } catch (error) {
            sessionStartupTraceRuntime.cancel(startupTrace.runtimeHandle, 'spawn-failed');
            const message = error instanceof Error ? error.message : 'Failed to start session';
            const pending = pendingHydration.current as PendingHydration | null;
            const launch = pendingLaunch.current;
            if (mountedRef.current && (pending || launch?.conversation)) setHydrationError({ sessionId: pending?.sessionId ?? launch!.conversation!.rootId });
            if (!pending && !launch?.conversation) pendingLaunch.current = null;
            if (mountedRef.current) Modal.alert(t('common.error'), message);
            return false;
        } finally {
            spawningRef.current = false;
            endSending();
        }
    }, [beginSending, endSending, finishLaunch]);

    const retryHydration = React.useCallback(async (): Promise<boolean> => {
        const launch = pendingLaunch.current;
        if (mountedRef.current && launch && !launch.retrying && !spawningRef.current) {
            launch.retrying = true;
            spawningRef.current = true;
            beginSending();
            try { return await finishLaunch(launch); }
            catch (error) { if (mountedRef.current) Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error)); return false; }
            finally { launch.retrying = false; spawningRef.current = false; endSending(); }
        }
        if (spawningRef.current) return false;
        const pending = pendingHydration.current;
        if (!mountedRef.current || !pending || pending.retrying) {
            return false;
        }

        pending.retrying = true;
        beginSending();
        try {
            markSessionCriticalPathHydrationRetry();
            const hydrated = await ensureSessionHydratedWithRetry(pending.sessionId);
            if (!hydrated) {
                return false;
            }
            if (!mountedRef.current || pendingHydration.current !== pending) return false;

            traceWebStartupStage(pending.trace, 'web.session.hydrated', pending.sessionId);
            if (!pending.configured) {
                configureSpawnedSession(pending.sessionId, pending.args);
                pending.configured = true;
            }
            if (!mountedRef.current || pendingHydration.current !== pending) return false;

            return await finishPending(pending);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start session';
            if (mountedRef.current) Modal.alert(t('common.error'), message);
            return false;
        } finally {
            pending.retrying = false;
            endSending();
        }
    }, [beginSending, endSending, finishLaunch, finishPending]);

    return { sending, hydrationError, retryHydration, spawnSession, spawn };
}
