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
    level: TaskPermissionLevel | null;
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
        () => resolveAgentDefaultConfig(agentDefaultOverrides, defaultsFlavor),
        [agentDefaultOverrides, defaultsFlavor],
    );
    const currentAgentMode = session.permissionMode
        ?? session.metadata?.currentOperatingModeCode
        ?? effectiveDefaults.permissionMode;
    const level = getTaskPermissionLevelForAgentMode(flavor, currentAgentMode);
    const supported = agent !== null;
    const unavailableReason = online
        ? (supported ? null : t('agentInput.taskPermission.unsupported'))
        : t('newSession.machineOffline');

    const onLevelChange = React.useCallback(async (nextLevel: TaskPermissionLevel) => {
        if (!online || !agent) {
            return false;
        }
        const nextAgentMode = getAgentPermissionModeForTaskLevel(flavor, nextLevel);
        if (!nextAgentMode) {
            return false;
        }

        return applyTaskPermissionSelection({
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
            apply: () => {
                storage.getState().updateSessionPermissionMode(session.id, nextAgentMode);
                if (agent === 'codex') {
                    void sessionSetPermissionMode(session.id, nextAgentMode).catch((error) => {
                        console.error('Failed to push permission mode to running Codex session:', error);
                    });
                }
            },
        });
    }, [agent, flavor, online, session.id]);

    return React.useMemo(() => ({
        online,
        supported,
        level,
        unavailableReason,
        onLevelChange,
    }), [level, onLevelChange, online, supported, unavailableReason]);
}
