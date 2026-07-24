import * as React from 'react';
import { useAllMachines, useSetting } from '@/sync/storage';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { machineSpawnNewSession, sessionSetAgentModes, type SessionAgentModesPatch } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { createWorktree } from '@/utils/worktree';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
} from '@/components/modelModeOptions';
import { Modal } from '@/modal';
import { t } from '@/text';

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

        const defaults = resolveAgentDefaultConfig(defaultOverrides, draft.agentType);
        const permission = resolveOption(
            getHardcodedPermissionModes(draft.agentType, t),
            [draft.permissionMode, defaults.permissionMode],
        );
        const model = resolveOption(
            getHardcodedModelModes(draft.agentType, t),
            [draft.modelMode, defaults.modelMode],
        );
        const effort = resolveOption(
            getEffortLevelsForModel(draft.agentType, model?.key ?? 'default'),
            [draft.effortLevel, defaults.effortLevel],
        );
        if (!permission || !model) {
            Modal.alert(t('common.error'), 'The selected agent configuration is unavailable');
            return false;
        }

        const prompt = draft.input.trim();
        const attachments = draft.attachments;
        const selectedPath = draft.selectedPath?.trim() || '~';
        const absolutePath = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir);
        const worktreeSelection = draft.sessionType === 'worktree'
            ? draft.worktreeKey ?? '__new__'
            : '__none__';

        isStartingRef.current = true;
        setIsStarting(true);
        try {
            let spawnDirectory = absolutePath;
            if (worktreeSelection === '__new__') {
                const worktreeResult = await createWorktree(machine.id, absolutePath);
                if (!worktreeResult.success) {
                    Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                    return false;
                }
                spawnDirectory = worktreeResult.worktreePath;
            } else if (worktreeSelection !== '__none__') {
                spawnDirectory = worktreeSelection;
            }

            const spawn = async (approvedNewDirectoryCreation = false): Promise<string | null> => {
                const result = await machineSpawnNewSession({
                    machineId: machine.id,
                    directory: spawnDirectory,
                    approvedNewDirectoryCreation,
                    agent: draft.agentType,
                    permissionMode: draft.agentType === 'codex' || permission.key !== 'default'
                        ? permission.key
                        : undefined,
                    modelMode: model.key !== 'default' ? model.key : undefined,
                    effortLevel: effort?.key,
                });

                if (result.type === 'success') return result.sessionId;
                if (result.type === 'error') {
                    Modal.alert(t('common.error'), result.errorMessage);
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

            await sync.refreshSessions();

            const modesPatch: SessionAgentModesPatch = {};
            if (permission.key !== defaults.permissionMode) modesPatch.permissionMode = permission.key;
            if (model.key !== defaults.modelMode) modesPatch.modelMode = model.key;
            if ((effort?.key ?? null) !== defaults.effortLevel) modesPatch.effortLevel = effort?.key ?? null;
            if (Object.keys(modesPatch).length > 0) {
                sessionSetAgentModes(sessionId, modesPatch);
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
            setIsStarting(false);
        }
    }, [defaultOverrides, machines, navigateToSession]);

    return { isStarting, startSession };
}
