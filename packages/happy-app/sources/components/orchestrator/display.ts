import type { OrchestratorExecutionRecord, OrchestratorRunSummary, OrchestratorTaskRecord } from '@/sync/apiOrchestrator';
import { MODEL_MODE_DEFAULT } from 'happy-wire';

function isMarkdownFenceLine(value: string): boolean {
    return /^```(?:[\w-]+)?$/.test(value.trim());
}

export function formatOrchestratorProviderLabel(task: Pick<OrchestratorTaskRecord, 'provider' | 'model'>): string {
    const model = task.model?.trim() || MODEL_MODE_DEFAULT;
    return `${task.provider} · ${model}`;
}

export function resolveOrchestratorAttemptDisplay(task: Pick<OrchestratorTaskRecord, 'retry' | 'executions'>): { current: number; max: number; } {
    const executions = task.executions ?? [];
    const maxAttempt = executions.reduce((value, execution) => Math.max(value, execution.attempt), 0);
    const current = Math.max(executions.length, maxAttempt);
    const max = Math.max(task.retry.maxAttempts, current);
    return { current, max };
}

export function resolveTaskMachineId(task: Pick<OrchestratorTaskRecord, 'executions' | 'status'>): string | null {
    const executions = task.executions ?? [];
    if (executions.length === 0) {
        return null;
    }
    if (task.status === 'running' || task.status === 'dispatching') {
        const active = executions.filter((execution) => execution.status === 'running' || execution.status === 'dispatching');
        if (active.length > 0) {
            return active[active.length - 1].machineId;
        }
    }
    return executions[executions.length - 1].machineId;
}

export function shortenMachineId(machineId: string): string {
    return machineId.length > 8 ? machineId.substring(0, 8) : machineId;
}

export function resolveMachineName(machineId: string, nameMap: ReadonlyMap<string, string>): string {
    const name = nameMap.get(machineId);
    if (name) {
        return `${name} (${shortenMachineId(machineId)})`;
    }
    return shortenMachineId(machineId);
}

export function sanitizeOrchestratorOutputSummary(summary: string | null | undefined): string | null {
    if (!summary) {
        return null;
    }

    const cleaned = summary
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isMarkdownFenceLine(line));

    if (cleaned.length === 0) {
        return null;
    }

    return cleaned.join(' ').trim();
}

export function resolveOrchestratorSummaryLineData(summary: OrchestratorRunSummary): Pick<OrchestratorRunSummary, 'total' | 'running' | 'completed' | 'failed' | 'cancelled'> {
    const running = summary.running + summary.queued;
    return {
        total: summary.total,
        running,
        completed: summary.completed,
        failed: summary.failed,
        cancelled: summary.cancelled,
    };
}

export function resolveOrchestratorSummaryLineDataFromTasks(
    summary: OrchestratorRunSummary,
    tasks: Array<Pick<OrchestratorTaskRecord, 'status'>> | undefined,
): Pick<OrchestratorRunSummary, 'total' | 'running' | 'completed' | 'failed' | 'cancelled'> {
    if (!tasks || tasks.length === 0) {
        return resolveOrchestratorSummaryLineData(summary);
    }

    let running = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;

    for (const task of tasks) {
        if (task.status === 'queued' || task.status === 'dispatching' || task.status === 'running') {
            running += 1;
            continue;
        }
        if (task.status === 'completed') {
            completed += 1;
            continue;
        }
        if (task.status === 'failed' || task.status === 'dependency_failed') {
            failed += 1;
            continue;
        }
        if (task.status === 'cancelled') {
            cancelled += 1;
        }
    }

    return {
        total: tasks.length,
        running,
        completed,
        failed,
        cancelled,
    };
}

export function sortOrchestratorExecutionsByAttemptDesc(executions: OrchestratorExecutionRecord[]): OrchestratorExecutionRecord[] {
    return [...executions].sort((a, b) => b.attempt - a.attempt);
}
