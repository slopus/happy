import * as React from 'react';
import { useAllMachines, useSetting } from '@/sync/storage';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { machineSpawnNewSession, sessionSetAgentModes, type SessionAgentModesPatch } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { createWorktree, generateWorktreeName } from '@/utils/worktree';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
} from '@/components/modelModeOptions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveMachineAgent } from '@/utils/newSessionAgentSelection';
import { delay } from '@/utils/time';
import {
    buildRigSpawnConfiguration,
    getRigMachineSessionCreation,
    resolveRigPendingRetryDelayMs,
} from '@/sync/rigSessionCreation';
import {
    buildSpawnRequestSignature,
    completeSpawnRequest,
    resolveSpawnRequestId,
} from '@/sync/spawnRequestId';

// A worktree spawn is bounded by a real `git worktree add`: on a large repo
// the checkout takes tens of seconds (48s observed on this codebase), while
// Rig holds each RPC only ~8s before answering `pending`. Three retries gave
// up at ~40s — right before the workspace turned ready, orphaning it. The
// budget must comfortably exceed a slow checkout; each retry is cheap.
const MAX_RIG_PENDING_RESULTS = 15;

function resolveOption<T extends { key: string }>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        if (!key) continue;
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

export function useStartSessionFromDraft() {
    const machines = useAllMachines({ includeOffline: true });
    const defaultOverrides = useSetting('agentDefaultOverrides');
    const navigateToSession = useNavigateToSession();
    const [isStarting, setIsStarting] = React.useState(false);
    const isStartingRef = React.useRef(false);
    const isMountedRef = React.useRef(true);
    React.useEffect(() => () => {
        isMountedRef.current = false;
    }, []);

    const startSession = React.useCallback(async (): Promise<boolean> => {
        if (isStartingRef.current) return false;

        const draft = useNewSessionDraft.getState();
        const machine = machines.find((candidate) => candidate.id === draft.selectedMachineId);
        if (!machine) {
            Modal.alert(t('common.error'), 'Please select a machine');
            return false;
        }
        if (!isMachineOnline(machine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return false;
        }

        // The draft survives machine changes and app upgrades. Resolve it again
        // at launch time so a stale Claude selection cannot spawn Claude while
        // the selected machine only reports Codex (the Android 1.7.0 regression).
        const agentType = machine.metadata?.rigOnly === true
            ? 'rig'
            : resolveMachineAgent(
                draft.agentType,
                machine.metadata?.cliAvailability,
            );
        const agentChanged = agentType !== draft.agentType;
        const rigCreation = agentType === 'rig'
            ? getRigMachineSessionCreation(machine.metadata)
            : null;
        if (agentType === 'rig' && !rigCreation) {
            Modal.alert(t('common.error'), 'This Rig machine is not available for session creation');
            return false;
        }
        const defaults = rigCreation
            ? {
                permissionMode: rigCreation.defaultPermissionMode ?? '',
                modelMode: rigCreation.defaultModelKey ?? '',
                effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agentType);
        const permission = resolveOption<{ key: string }>(
            rigCreation?.permissionModes ?? getHardcodedPermissionModes(agentType, t),
            agentChanged
                ? [defaults.permissionMode]
                : [draft.permissionMode, defaults.permissionMode],
        );
        const model = resolveOption<{ key: string }>(
            rigCreation?.models ?? getHardcodedModelModes(agentType, t),
            agentChanged
                ? [defaults.modelMode]
                : [draft.modelMode, defaults.modelMode],
        );
        const effortDefault = rigCreation?.defaultEffortForModel(model?.key)
            ?? defaults.effortLevel;
        const effort = resolveOption<{ key: string }>(
            rigCreation
                ? rigCreation.effortsForModel(model?.key).map((key) => ({ key, name: key }))
                : getEffortLevelsForModel(agentType, model?.key ?? 'default'),
            agentChanged
                ? [effortDefault]
                : [draft.effortLevel, effortDefault],
        );
        if (!permission || !model) {
            Modal.alert(t('common.error'), 'The selected agent configuration is unavailable');
            return false;
        }

        const prompt = draft.input.trim();
        const attachments = draft.attachments;
        const selectedPath = draft.selectedPath?.trim() || '~';
        const absolutePath = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir);
        // A Rig machine that cannot make worktrees must not silently fall back
        // to the project root: the session would look successful while doing
        // something materially different from what the user requested.
        if (draft.sessionType === 'worktree' && rigCreation && !rigCreation.supportsWorktrees) {
            Modal.alert(
                t('common.error'),
                'This Rig machine does not support worktrees. Update Rig on it, or start the session without one.',
            );
            return false;
        }
        const worktreeSelection = draft.sessionType === 'worktree'
            ? draft.worktreeKey ?? '__new__'
            : '__none__';
        // Keep an automatically generated name in the non-persistent draft.
        // A retry must request the same worktree as the first attempt, not a
        // second randomly named one under the same idempotency key.
        const requestedWorktreeName = draft.newWorktreeName?.trim();
        const newWorktreeName = worktreeSelection === '__new__'
            ? requestedWorktreeName || generateWorktreeName()
            : null;
        if (newWorktreeName && !requestedWorktreeName) {
            draft.setNewWorktreeName(newWorktreeName);
        }
        isStartingRef.current = true;
        setIsStarting(true);
        try {
            let spawnDirectory = absolutePath;
            let rigNewWorktreeName: string | null = null;
            if (worktreeSelection === '__new__') {
                // `newWorktreeName` was resolved before minting the idempotency
                // key, so the worktree payload and key always describe the
                // same request.
                const worktreeName = newWorktreeName!;
                if (rigCreation) {
                    rigNewWorktreeName = worktreeName;
                } else {
                    const worktreeResult = await createWorktree(machine.id, absolutePath, worktreeName);
                    if (!worktreeResult.success) {
                        Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                        return false;
                    }
                    spawnDirectory = worktreeResult.worktreePath;
                }
            } else if (worktreeSelection !== '__none__') {
                spawnDirectory = worktreeSelection;
            }

            // Reused across every retry of this exact request so a second
            // press of Start is deduped by Rig instead of spawning a second
            // session. Use the same resolved directory that reaches Rig:
            // `~/project` and its absolute spelling are one request.
            const clientRequestId = resolveSpawnRequestId(buildSpawnRequestSignature({
                machineId: machine.id,
                agent: agentType,
                directory: spawnDirectory,
                worktree: worktreeSelection,
                newWorktreeName,
                modelKey: model.key,
                permissionMode: permission.key,
                effort: effort?.key ?? null,
            }));

            const spawn = async (approvedNewDirectoryCreation = false): Promise<string | null> => {
                const spawnOptions = rigCreation
                    ? {
                        machineId: machine.id,
                        ...buildRigSpawnConfiguration(machine.metadata, {
                            directory: spawnDirectory,
                            clientRequestId,
                            approvedNewDirectoryCreation,
                            modelKey: model.key,
                            permissionMode: permission.key,
                            effort: effort?.key,
                            newWorktreeName: rigNewWorktreeName,
                        }),
                    }
                    : {
                        machineId: machine.id,
                        directory: spawnDirectory,
                        approvedNewDirectoryCreation,
                        agent: agentType,
                        permissionMode: agentType === 'codex' || permission.key !== 'default'
                            ? permission.key
                            : undefined,
                        modelMode: model.key !== 'default' ? model.key : undefined,
                        effortLevel: effort?.key,
                    };
                let result = await machineSpawnNewSession(spawnOptions);
                let pendingResults = 0;
                while (result.type === 'pending' && pendingResults < MAX_RIG_PENDING_RESULTS) {
                    pendingResults += 1;
                    await delay(resolveRigPendingRetryDelayMs(
                        result.retryAfterMs,
                        rigCreation?.pendingRetryAfterMs,
                    ));
                    if (!isMountedRef.current) return null;
                    result = await machineSpawnNewSession(spawnOptions);
                }
                if (!isMountedRef.current) return null;

                if (result.type === 'success') return result.sessionId;
                if (result.type === 'error') {
                    Modal.alert(t('common.error'), result.errorMessage);
                    return null;
                }
                if (result.type === 'pending') {
                    // Not an error and nothing is lost: the workspace
                    // reservation is durable and the idempotency key is kept,
                    // so the next Start resumes this same request.
                    Modal.alert(
                        t('newSession.rigStillPreparingTitle'),
                        t('newSession.rigStillPreparingMessage'),
                    );
                    return null;
                }

                const approved = await Modal.confirm(
                    'Create Directory?',
                    `The directory '${result.directory}' does not exist. Would you like to create it?`,
                    { cancelText: t('common.cancel'), confirmText: t('common.create') },
                );
                return approved ? spawn(true) : null;
            };

            const sessionId = await spawn();
            if (!sessionId) return false;
            // The idempotency key did its job; the next Start is a new session.
            completeSpawnRequest();

            await sync.refreshSessions();

            if (!rigCreation) {
                const modesPatch: SessionAgentModesPatch = {};
                if (permission.key !== defaults.permissionMode) modesPatch.permissionMode = permission.key;
                if (model.key !== defaults.modelMode) modesPatch.modelMode = model.key;
                if ((effort?.key ?? null) !== defaults.effortLevel) modesPatch.effortLevel = effort?.key ?? null;
                if (Object.keys(modesPatch).length > 0) {
                    sessionSetAgentModes(sessionId, modesPatch);
                }
            }

            draft.setInput('');
            draft.setAttachments([]);
            navigateToSession(sessionId);
            if (prompt || attachments.length > 0) {
                // The session is ready at this point. Open it immediately and
                // let the first message enqueue without keeping the user on Home
                // during image upload or a slower network round-trip.
                void sync.sendMessage(sessionId, prompt, { source: 'new_session', attachments }).catch((error) => {
                    Modal.alert(
                        t('common.error'),
                        error instanceof Error ? error.message : 'Failed to send the first message',
                    );
                });
            }
            return true;
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : 'Failed to start session',
            );
            return false;
        } finally {
            isStartingRef.current = false;
            if (isMountedRef.current) setIsStarting(false);
        }
    }, [defaultOverrides, machines, navigateToSession]);

    return { isStarting, startSession };
}
