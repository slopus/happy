export const RUN_TERMINAL_STATUSES = new Set([
    'completed',
    'failed',
    'cancelled',
]);

export const EXECUTION_TERMINAL_STATUSES = new Set([
    'completed',
    'failed',
    'cancelled',
    'timeout',
]);

export type RunSummary = {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
};

type RunSummaryInternal = RunSummary & {
    dispatching: number;
};

export function isRunTerminal(status: string): boolean {
    return RUN_TERMINAL_STATUSES.has(status);
}

export function isExecutionTerminal(status: string): boolean {
    return EXECUTION_TERMINAL_STATUSES.has(status);
}

export function createEmptySummaryInternal(): RunSummaryInternal {
    return {
        total: 0,
        queued: 0,
        dispatching: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
    };
}

export function addTaskCount(summary: RunSummaryInternal, status: string, count: number): void {
    summary.total += count;
    if (status === 'queued') {
        summary.queued += count;
    } else if (status === 'dispatching') {
        summary.dispatching += count;
    } else if (status === 'running') {
        summary.running += count;
    } else if (status === 'completed') {
        summary.completed += count;
    } else if (status === 'failed') {
        summary.failed += count;
    } else if (status === 'cancelled') {
        summary.cancelled += count;
    }
}

export function toPublicSummary(summary: RunSummaryInternal): RunSummary {
    return {
        total: summary.total,
        queued: summary.queued,
        running: summary.running + summary.dispatching,
        completed: summary.completed,
        failed: summary.failed,
        cancelled: summary.cancelled,
    };
}

export function deriveRunStatus(currentStatus: string, summary: RunSummaryInternal): string {
    const activeCount = summary.queued + summary.dispatching + summary.running;

    if (currentStatus === 'canceling') {
        return activeCount > 0 ? 'canceling' : 'cancelled';
    }

    if (activeCount > 0) {
        if (summary.dispatching > 0 || summary.running > 0 || summary.completed > 0 || summary.failed > 0 || summary.cancelled > 0) {
            return 'running';
        }
        return 'queued';
    }

    if (summary.failed > 0) {
        return 'failed';
    }

    if (summary.cancelled > 0 && summary.completed === 0) {
        return 'cancelled';
    }

    // v1 semantics: partial success (completed + cancelled without failed) is treated as completed.
    // Cancellation here means user stopped remaining tasks; successfully finished tasks still make the run successful.
    return 'completed';
}

export function encodeListCursor(createdAt: Date, id: string): string {
    return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeListCursor(cursor: string): { createdAt: Date; id: string } | null {
    try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const [createdAtRaw, id] = decoded.split('|');
        if (!createdAtRaw || !id) {
            return null;
        }
        const createdAt = new Date(createdAtRaw);
        if (Number.isNaN(createdAt.getTime())) {
            return null;
        }
        return { createdAt, id };
    } catch (_error) {
        return null;
    }
}

export function buildPendCursor(args: {
    runId: string;
    updatedAt: Date;
    status: string;
    summary: RunSummary;
}): string {
    const value = `${args.runId}|${args.updatedAt.toISOString()}|${args.status}|${args.summary.total}|${args.summary.queued}|${args.summary.running}|${args.summary.completed}|${args.summary.failed}|${args.summary.cancelled}`;
    return Buffer.from(value, 'utf8').toString('base64url');
}
