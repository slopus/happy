import type { OrchestratorExecutionStatus, OrchestratorRunStatus, OrchestratorTaskStatus } from '@/sync/apiOrchestrator';
import type { UnistylesThemes } from 'react-native-unistyles';

type AnyStatus = OrchestratorRunStatus | OrchestratorTaskStatus | OrchestratorExecutionStatus;

export function getStatusLabel(status: AnyStatus): string {
    switch (status) {
        case 'queued':
            return 'Queued';
        case 'dispatching':
            return 'Dispatching';
        case 'running':
            return 'Running';
        case 'canceling':
            return 'Canceling';
        case 'completed':
            return 'Completed';
        case 'failed':
            return 'Failed';
        case 'cancelled':
            return 'Cancelled';
        case 'timeout':
            return 'Timeout';
        case 'dependency_failed':
            return 'Dependency Failed';
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
