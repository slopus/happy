import type { AgentGoalStatus } from '@/api/types';
import type { ThreadGoal } from './codexAppServerTypes';

type CodexGoalEvent = Record<string, unknown>;
type AgentGoalCapabilities = NonNullable<Extract<AgentGoalStatus, { status: 'active' }>['capabilities']>;

type CodexGoalStatusBase = {
    source: 'codex';
    observedAt: number;
    sourceSessionId: string;
    sourceRevision?: string | number;
};

export type CodexGoalCommand =
    | { type: 'set'; objective: string }
    | { type: 'clear' };

const ACTIVE_CODEX_GOAL_STATUSES = new Set([
    'active',
    'paused',
    'blocked',
    'usageLimited',
    'budgetLimited',
]);

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function goalRecord(value: unknown): (ThreadGoal & Record<string, unknown>) | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as ThreadGoal & Record<string, unknown>
        : null;
}

function eventThreadId(message: CodexGoalEvent): string | null {
    const goal = goalRecord(message.goal);
    return nonEmptyString(message.threadId)
        ?? nonEmptyString(message.thread_id)
        ?? nonEmptyString(goal?.threadId)
        ?? nonEmptyString(goal?.thread_id);
}

function baseStatus(threadId: string, sourceRevision?: string | number): CodexGoalStatusBase {
    return {
        source: 'codex',
        observedAt: Date.now(),
        sourceSessionId: threadId,
        ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    };
}

export function mapCodexGoalEventToAgentGoalStatus(
    message: CodexGoalEvent,
    currentThreadId?: string | null,
    opts?: { capabilities?: AgentGoalCapabilities },
): AgentGoalStatus | null {
    if (message.type !== 'thread_goal_updated' && message.type !== 'thread_goal_cleared') {
        return null;
    }

    const threadId = eventThreadId(message) ?? currentThreadId ?? null;
    if (!threadId) {
        return null;
    }
    if (currentThreadId && threadId !== currentThreadId) {
        return null;
    }

    if (message.type === 'thread_goal_cleared') {
        return {
            ...baseStatus(threadId),
            status: 'inactive',
            reason: 'cleared',
        };
    }

    const goal = goalRecord(message.goal);
    if (!goal) {
        return {
            ...baseStatus(threadId),
            status: 'unavailable',
            reason: 'malformed',
        };
    }

    const objective = nonEmptyString(goal.objective);
    const sourceRevision = finiteNumber(goal.updatedAt) ?? undefined;
    const status = nonEmptyString(goal.status);

    if (status === 'complete') {
        return {
            ...baseStatus(threadId, sourceRevision),
            status: 'inactive',
            reason: 'completed',
        };
    }

    if (!status || !ACTIVE_CODEX_GOAL_STATUSES.has(status) || !objective) {
        return {
            ...baseStatus(threadId, sourceRevision),
            status: 'unavailable',
            reason: 'malformed',
        };
    }

    return {
        ...baseStatus(threadId, sourceRevision),
        status: 'active',
        text: objective,
        ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
    };
}

export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/goal(?:\s+([\s\S]+))?$/i);
    if (!match) {
        return null;
    }

    const objective = match[1]?.trim() ?? '';
    if (!objective) {
        return null;
    }

    if (objective.toLowerCase() === 'clear') {
        return { type: 'clear' };
    }

    return { type: 'set', objective };
}
