import type { OrchestratorExecutionStatus, OrchestratorRunStatus, OrchestratorTaskStatus } from '@/sync/apiOrchestrator';
import type { UnistylesThemes } from 'react-native-unistyles';
import { t } from '@/text';

type AnyStatus = OrchestratorRunStatus | OrchestratorTaskStatus | OrchestratorExecutionStatus;

export function getStatusLabel(status: AnyStatus): string {
    switch (status) {
        case 'queued':
            return t('settings.orchestratorStatusQueued');
        case 'dispatching':
            return t('settings.orchestratorStatusDispatching');
        case 'running':
            return t('settings.orchestratorStatusRunning');
        case 'canceling':
            return t('settings.orchestratorStatusCanceling');
        case 'completed':
            return t('settings.orchestratorStatusCompleted');
        case 'failed':
            return t('settings.orchestratorStatusFailed');
        case 'cancelled':
            return t('settings.orchestratorStatusCancelled');
        case 'timeout':
            return t('settings.orchestratorStatusTimeout');
        case 'dependency_failed':
            return t('settings.orchestratorStatusDependencyFailed');
        default:
            return status;
    }
}

export function isRunActive(status: OrchestratorRunStatus): boolean {
    return status === 'queued' || status === 'running' || status === 'canceling';
}

export function getStatusColor(theme: UnistylesThemes['light'], status: AnyStatus): string {
    switch (status) {
        case 'completed':
            return theme.colors.status.connected;
        case 'running':
        case 'dispatching':
            return theme.colors.status.connecting;
        case 'queued':
            return theme.colors.textSecondary;
        case 'failed':
        case 'timeout':
        case 'dependency_failed':
            return theme.colors.status.error;
        case 'canceling':
            return theme.colors.warning;
        case 'cancelled':
            return theme.colors.textSecondary;
        default:
            return theme.colors.textSecondary;
    }
}
