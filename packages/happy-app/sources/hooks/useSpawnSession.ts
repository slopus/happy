import * as React from 'react';
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
}

export type SpawnSessionCoreResult =
    | { type: 'success'; sessionId: string }
    | { type: 'cancelled' }
    | { type: 'error'; message: string };

/**
 * Inline session spawn used by the compose-first home. The non-navigating core
 * resolves/spawns/configures a session, while `spawn` preserves the existing
 * send-once then navigate behavior for current callers.
 */
export function useSpawnSession() {
    const navigateToSession = useNavigateToSession();
    const [sending, setSending] = React.useState(false);
    const sendingOperations = React.useRef(0);
    const beginSending = React.useCallback(() => {
        sendingOperations.current += 1;
        if (sendingOperations.current === 1) setSending(true);
    }, []);
    const endSending = React.useCallback(() => {
        sendingOperations.current = Math.max(0, sendingOperations.current - 1);
        if (sendingOperations.current === 0) setSending(false);
    }, []);

    const spawnSession = React.useCallback(async (
        args: SpawnSessionArgs,
        approvedNewDirectoryCreation: boolean = false,
    ): Promise<SpawnSessionCoreResult> => {
        const { machineId, machine, path, agent, worktreeKey, permissionMode, modelMode, effortLevel, fastMode, environmentVariables } = args;
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
                });

                switch (result.type) {
                    case 'success': {
                        // 新会话的 socket 更新可能已经触发全量账户刷新。继续等待共享队列，
                        // 会导致 /new 导航前重复解密全部历史记录，即使守护进程已经创建会话。
                        // 因此先只补齐本次返回的会话；若旧服务端尚未返回该记录，
                        // 或会话记录异常延迟，再回退到全量刷新以保证兼容性。
                        const hydrated = await sync.refreshSession(result.sessionId);
                        if (!hydrated) {
                            await sync.refreshSessions();
                        }
                        const sessionStorage = storage.getState();
                        if (permissionMode !== undefined) {
                            sessionStorage.updateSessionPermissionMode(result.sessionId, permissionMode);
                        }
                        if (modelMode !== undefined) {
                            sessionStorage.updateSessionModelMode(result.sessionId, modelMode);
                        }
                        if (effortLevel !== undefined) {
                            sessionStorage.updateSessionEffortLevel(result.sessionId, effortLevel);
                        }
                        if (fastMode !== undefined) {
                            sessionStorage.updateSessionFastMode(result.sessionId, fastMode);
                        }
                        return { type: 'success', sessionId: result.sessionId };
                    }
                    case 'requestToApproveDirectoryCreation': {
                        const approved = await Modal.confirm(
                            t('composeHome.createDirectoryTitle'),
                            t('composeHome.createDirectoryMessage', { path: result.directory }),
                            { cancelText: t('common.cancel'), confirmText: t('common.create') },
                        );
                        return approved ? runSpawn(true) : { type: 'cancelled' };
                    }
                    case 'error':
                        Modal.alert(t('common.error'), result.errorMessage);
                        return { type: 'error', message: result.errorMessage };
                }
            };

            return await runSpawn(approvedNewDirectoryCreation);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start session';
            Modal.alert(t('common.error'), message);
            return { type: 'error', message };
        } finally {
            endSending();
        }
    }, [beginSending, endSending]);

    // Returns true when a session was created (so callers can clear their input).
    const spawn = React.useCallback(async (
        args: SpawnSessionArgs,
        approvedNewDirectoryCreation: boolean = false,
    ): Promise<boolean> => {
        beginSending();
        try {
            const result = await spawnSession(args, approvedNewDirectoryCreation);
            if (result.type !== 'success') {
                return false;
            }

            const attachments = args.images && args.images.length > 0 ? args.images : undefined;
            if (args.prompt || attachments) {
                await sync.sendMessage(result.sessionId, args.prompt, { source: 'new_session', attachments });
            }
            navigateToSession(result.sessionId);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to start session';
            Modal.alert(t('common.error'), message);
            return false;
        } finally {
            endSending();
        }
    }, [beginSending, endSending, navigateToSession, spawnSession]);

    return { sending, spawnSession, spawn };
}
