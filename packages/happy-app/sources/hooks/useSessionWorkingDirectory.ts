import * as React from 'react';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { machineBrowseDirectory, forkAndSpawn, machineSpawnNewSession } from '@/sync/ops';
import { storage, useAllSessions, useMachine } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionForkSource } from '@/utils/sessionFork';
import {
    formatWorkingDirectoryLabel,
    getRecentWorkingDirectories,
    resolveWorkingDirectoryAgent,
    resolveWorkingDirectorySwitchStrategy,
} from '@/utils/sessionWorkingDirectory';

export type WorkingDirectorySwitchResult =
    | { success: true; changed: boolean; path: string }
    | { success: false; error: string };

/**
 * Orchestrates a next-turn working-directory switch without mutating the
 * source session: validate the canonical target on its Agent, select the
 * flavor capability, fork provider context or spawn a same-type session,
 * attempt to hydrate it (falling back to a sessions refresh), preserve
 * permission/model/effort/draft state, then navigate. Validation, capability,
 * fork, or spawn failures return before navigation; no branch rewrites the
 * historical source session.
 */
export function useSessionWorkingDirectory(
    session: Session,
    getDraft: () => string,
) {
    const navigateToSession = useNavigateToSession();
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const sessions = useAllSessions();
    const currentPath = session.metadata?.path ?? '';
    const homeDir = machine?.metadata?.homeDir ?? session.metadata?.homeDir;
    const [switching, setSwitching] = React.useState(false);

    const recentPaths = React.useMemo(
        () => getRecentWorkingDirectories(sessions, machineId, currentPath),
        [currentPath, machineId, sessions],
    );

    const switchDirectory = React.useCallback(async (candidate: string): Promise<WorkingDirectorySwitchResult> => {
        if (!machineId || !machine || !isMachineOnline(machine)) {
            return { success: false, error: 'machine-offline' };
        }
        if (session.thinking) {
            return { success: false, error: 'session-busy' };
        }

        setSwitching(true);
        try {
            // The machine-level browser is also the validation boundary: it resolves
            // the path on the owning Agent, rejects paths outside that machine's home,
            // and fails when the directory is missing or unreadable.
            const validation = await machineBrowseDirectory(machineId, candidate.trim());
            if (!validation.success || !validation.path) {
                return { success: false, error: validation.error ?? 'invalid-directory' };
            }
            const targetPath = validation.path;
            if (targetPath === currentPath) {
                return { success: true, changed: false, path: targetPath };
            }

            const forkSource = getSessionForkSource(session);
            const switchStrategy = resolveWorkingDirectorySwitchStrategy(
                session.metadata?.flavor,
                forkSource !== null,
            );
            if (switchStrategy === 'continuation-unavailable') {
                return { success: false, error: 'continuation-unavailable' };
            }
            if (switchStrategy === 'unsupported') {
                return { success: false, error: 'unsupported-agent' };
            }
            const agent = resolveWorkingDirectoryAgent(session.metadata?.flavor);
            if (switchStrategy === 'new-session' && !agent) {
                return { success: false, error: 'unsupported-agent' };
            }

            const result = switchStrategy === 'continue-context'
                ? await forkAndSpawn(forkSource!, { targetDirectory: targetPath })
                : await machineSpawnNewSession({
                    machineId,
                    directory: targetPath,
                    approvedNewDirectoryCreation: false,
                    agent: agent!,
                    parentSessionId: session.id,
                });

            if (result.type !== 'success') {
                return {
                    success: false,
                    error: result.type === 'error' ? result.errorMessage : 'directory-creation-required',
                };
            }

            // forkAndSpawn already hydrates context continuations on its normal
            // path. Retry only when that row is still absent (for example after
            // a transient targeted-sync failure), because the local overrides
            // below are intentionally no-ops until the session exists.
            const spawnedSessionMissing = !storage.getState().sessions[result.sessionId];
            if (switchStrategy === 'new-session' || spawnedSessionMissing) {
                const hydrated = await sync.refreshSession(result.sessionId);
                if (!hydrated) {
                    await sync.refreshSessions();
                }
            }

            const sessionStorage = storage.getState();
            sessionStorage.updateSessionPermissionMode(result.sessionId, session.permissionMode ?? null);
            sessionStorage.updateSessionModelMode(result.sessionId, session.modelMode ?? null);
            sessionStorage.updateSessionEffortLevel(result.sessionId, session.effortLevel ?? null);
            sessionStorage.updateSessionDraft(result.sessionId, getDraft());
            navigateToSession(result.sessionId);
            return { success: true, changed: true, path: targetPath };
        } finally {
            setSwitching(false);
        }
    }, [currentPath, getDraft, machine, machineId, navigateToSession, session]);

    return {
        currentPath,
        currentPathLabel: formatWorkingDirectoryLabel(currentPath, homeDir),
        fullPath: currentPath,
        homeDir,
        machineId,
        machineOnline: Boolean(machine && isMachineOnline(machine)),
        recentPaths,
        switching,
        switchDirectory,
    };
}
