import * as React from 'react';
import { randomUUID } from 'expo-crypto';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { machineSpawnNewSession } from '@/sync/ops';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import type { Machine } from '@/sync/storageTypes';
import type { NewSessionAgentType } from '@/sync/persistence';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { organizeSession } from '@/sync/sidebarOrganization';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { traceStartup } from '@/sync/sessionStartupTrace';

export interface SpawnSessionArgs {
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
    /** Initial prompt to send into the freshly spawned session. */
    prompt: string;
    /** Image attachments to send with the initial message (claude-only). */
    images?: AttachmentPreview[];
    /** Extra environment passed to daemon-spawned agent process. */
    environmentVariables?: Record<string, string>;
    /** Optional sidebar List that should own the newly created session. */
    sidebarListId?: string | null;
}

export type SpawnSessionCoreResult =
    | { type: 'success'; sessionId: string }
    | { type: 'cancelled' }
    | { type: 'error'; message: string; sessionId?: string };

type PendingHydration = {
    sessionId: string;
    args: SpawnSessionArgs;
    trace: SessionStartupTraceContext;
    retrying: boolean;
    queued: boolean;
    configured: boolean;
    onQueued?: () => void;
};

type SessionStartupTraceContext = {
    traceId: string;
    startedAt: number;
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

function configureSpawnedSession(sessionId: string, args: SpawnSessionArgs): void {
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
    const sendingOperations = React.useRef(0);
    const spawningRef = React.useRef(false);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            pendingHydration.current = null;
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
        onRegistered?: (sessionId: string) => void,
    ): Promise<SpawnSessionCoreResult> => {
        if (!mountedRef.current) return { type: 'cancelled' };
        const { machineId, machine, path, agent, worktreeKey, environmentVariables } = args;
        if (!isMachineOnline(machine)) {
            const message = t('newSession.machineOffline');
            Modal.alert(t('common.error'), message);
            return { type: 'error', message };
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
                const result = await machineSpawnNewSession({
                    machineId,
                    directory: spawnDirectory,
                    approvedNewDirectoryCreation: approved,
                    agent,
                    environmentVariables,
                    ...(startupTrace ? { traceId: startupTrace.traceId } : {}),
                });

                switch (result.type) {
                    case 'success': {
                        if (!mountedRef.current) return { type: 'cancelled' };
                        onRegistered?.(result.sessionId);
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
                        return { type: 'success', sessionId: result.sessionId };
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
                        return { type: 'error', message: result.errorMessage };
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

    const finishPending = React.useCallback(async (pending: PendingHydration): Promise<boolean> => {
        if (!pending.queued) {
            const attachments = pending.args.images?.length ? pending.args.images : undefined;
            if (pending.args.prompt || attachments) {
                try {
                    const receipt = await sync.sendMessage(pending.sessionId, pending.args.prompt, { source: 'new_session', attachments });
                    if (receipt?.type !== 'queued' || receipt.sessionId !== pending.sessionId || !receipt.localIds.length) {
                        throw new Error('local-message-queue-unconfirmed');
                    }
                    pending.queued = true;
                    traceWebStartupStage(pending.trace, 'web.first_message.queued', pending.sessionId);
                } catch (error) {
                    traceWebStartupStage(pending.trace, 'web.first_message.queued', pending.sessionId, 'error', 'local-message-queue-failed');
                    throw error;
                }
            } else pending.queued = true;
        }
        if (!mountedRef.current || pendingHydration.current !== pending) return false;
        // The route may synchronously dismiss/unmount the compose component.
        // Transfer or clear its accepted draft before invoking navigation.
        pending.onQueued?.();
        navigateToSession(pending.sessionId);
        traceWebStartupStage(pending.trace, 'web.session.navigated', pending.sessionId);
        pendingHydration.current = null;
        if (mountedRef.current) setHydrationError(null);
        return true;
    }, [navigateToSession]);

    // Returns true when a session was created (so callers can clear their input).
    const spawn = React.useCallback(async (
        args: SpawnSessionArgs,
        approvedNewDirectoryCreation: boolean = false,
        onQueued?: () => void,
    ): Promise<boolean> => {
        if (!mountedRef.current || pendingHydration.current || spawningRef.current) {
            return false;
        }
        spawningRef.current = true;
        const startedAt = Date.now();
        const startupTrace: SessionStartupTraceContext = {
            traceId: randomUUID(),
            startedAt,
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
            const result = await spawnSession(args, approvedNewDirectoryCreation, startupTrace, sessionId => {
                pendingHydration.current = { sessionId, args, trace: startupTrace, retrying: false, queued: false, configured: false, onQueued };
            });
            if (!mountedRef.current) return false;
            if (result.type !== 'success') {
                const pending = pendingHydration.current as PendingHydration | null;
                if (pending) setHydrationError({ sessionId: pending.sessionId });
                return false;
            }

            const pending = pendingHydration.current!;
            pending.configured = true;
            return await finishPending(pending);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start session';
            const pending = pendingHydration.current as PendingHydration | null;
            if (mountedRef.current && pending) setHydrationError({ sessionId: pending.sessionId });
            if (mountedRef.current) Modal.alert(t('common.error'), message);
            return false;
        } finally {
            spawningRef.current = false;
            endSending();
        }
    }, [beginSending, endSending, finishPending, spawnSession]);

    const retryHydration = React.useCallback(async (): Promise<boolean> => {
        const pending = pendingHydration.current;
        if (!mountedRef.current || !pending || pending.retrying) {
            return false;
        }

        pending.retrying = true;
        beginSending();
        try {
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
    }, [beginSending, endSending, finishPending]);

    return { sending, hydrationError, retryHydration, spawnSession, spawn };
}
