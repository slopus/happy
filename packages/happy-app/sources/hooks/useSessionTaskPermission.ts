import { isRetiredAgentFlavor } from '@/sync/retiredSessions';
import { assertAccountRuntime } from '@/auth/accountRuntime';
import { beginAgyConfig, finishAgyConfig } from '@/sync/agyConfigPending';
import * as React from 'react';
import type { Session } from '@/sync/storageTypes';
import { storage, useSetting } from '@/sync/storage';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { sessionSetPermissionMode } from '@/sync/ops';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    getAgentPermissionModeForTaskLevel,
    getTaskPermissionLevelForAgentMode,
    resolveTaskPermissionAgent,
    type TaskPermissionLevel,
} from '@/utils/taskPermissionModes';
import {
    applyTaskPermissionSelection,
    taskPermissionConfirmationStore,
} from '@/utils/taskPermissionConfirmation';

export type SessionTaskPermissionController = {
    online: boolean;
    supported: boolean;
    supportsAutomatic?: boolean;
    level: TaskPermissionLevel | null;
    currentMode?: string | null;
    unavailableReason: string | null;
    onLevelChange: (level: TaskPermissionLevel) => Promise<boolean>;
};

export function useSessionTaskPermission(
    session: Session,
    online: boolean,
): SessionTaskPermissionController {
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const flavor = session.metadata?.flavor;
    const agent = resolveTaskPermissionAgent(flavor);
    const defaultsFlavor = agent ?? flavor;
    const effectiveDefaults = React.useMemo(
        () => isRetiredAgentFlavor(flavor) ? { permissionMode: 'default' } : resolveAgentDefaultConfig(agentDefaultOverrides, defaultsFlavor),
        [agentDefaultOverrides, defaultsFlavor, flavor],
    );
    const currentAgentMode = agent === 'antigravity'
        ? session.metadata?.acpPermissionMode ?? 'default'
        : session.permissionMode ?? session.metadata?.currentOperatingModeCode ?? effectiveDefaults.permissionMode;
    const level = getTaskPermissionLevelForAgentMode(flavor, currentAgentMode);
    const supported = agent !== null && (agent !== 'antigravity' || session.metadata?.capabilities?.acpPermissionPolicy === true || session.metadata?.acpPermissionMode !== undefined);
    const unavailableReason = online
        ? (supported ? null : t(agent === 'antigravity' ? 'agentInput.taskPermission.updateCli' : 'agentInput.taskPermission.unsupported'))
        : t('newSession.machineOffline');

    const onLevelChange = React.useCallback(async (nextLevel: TaskPermissionLevel) => {
        if (!online || !agent || !supported) {
            return false;
        }
        const nextAgentMode = getAgentPermissionModeForTaskLevel(flavor, nextLevel);
        if (!nextAgentMode) {
            return false;
        }

        try { return await applyTaskPermissionSelection({
            sessionId: session.id,
            level: nextLevel,
            store: taskPermissionConfirmationStore,
            confirmFullAccess: () => Modal.confirm(
                t('agentInput.taskPermission.riskTitle'),
                t('agentInput.taskPermission.riskMessage'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('agentInput.taskPermission.riskConfirm'),
                    destructive: true,
                },
            ),
            apply: async () => {
                if (agent === 'antigravity') {
                    if (!beginAgyConfig(session.id)) throw new Error('Another session configuration change is pending');
                    try {
                        const workerPid = storage.getState().sessions[session.id]?.metadata?.hostPid;
                        if (!await sessionSetPermissionMode(session.id, nextAgentMode)) throw new Error('Permission change was not acknowledged');
                        assertAccountRuntime();
                        const current = storage.getState().sessions[session.id];
                        if (!current || current.metadata?.flavor !== 'antigravity' || current.metadata.hostPid !== workerPid) throw new Error('Session worker changed');
                        storage.getState().applySessions([{ ...current, metadata: { ...current.metadata, acpPermissionMode: nextAgentMode as 'default' | 'bypassPermissions' } }]);
                    } finally { finishAgyConfig(session.id); }
                }
                storage.getState().updateSessionPermissionMode(session.id, nextAgentMode);
                if (agent === 'codex') {
                    void sessionSetPermissionMode(session.id, nextAgentMode).catch((error) => {
                        console.error('Failed to push permission mode to running Codex session:', error);
                    });
                }
            },
        }); } catch (error) {
            if (agent !== 'antigravity') throw error;
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
            return false;
        }
    }, [agent, flavor, online, session.id, supported]);

    return React.useMemo(() => ({
        online,
        supported,
        supportsAutomatic: agent === 'codex',
        currentMode: currentAgentMode,
        level,
        unavailableReason,
        onLevelChange,
    }), [agent, currentAgentMode, level, onLevelChange, online, supported, unavailableReason]);
}
