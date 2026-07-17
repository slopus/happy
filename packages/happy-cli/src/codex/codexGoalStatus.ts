import type { AgentGoalStatus, AgentGoalStatusV2 } from '@/api/types';
import type { ThreadGoal, ThreadGoalStatus } from './codexAppServerTypes';

type CodexGoalEvent = Record<string, unknown>;
type AgentGoalCapabilities = NonNullable<Extract<AgentGoalStatus, { status: 'active' }>['capabilities']>;
type AgentGoalCapabilitiesV2 = NonNullable<Extract<AgentGoalStatusV2, { status: 'active' }>['capabilities']>;

type CodexGoalStatusBase = {
    source: 'codex';
    observedAt: number;
    sourceSessionId: string;
    sourceRevision?: string | number;
};

export type CodexGoalProjection = {
    legacy: AgentGoalStatus;
    detailed: AgentGoalStatusV2;
};

export type CodexGoalCommand =
    | { type: 'set'; objective: string }
    | { type: 'set-status'; status: 'active' | 'paused' }
    | { type: 'edit' }
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

export function codexGoalActionCapabilities(supported: boolean): AgentGoalCapabilities | undefined {
    return supported ? { clear: true, edit: true } : undefined;
}

export function codexGoalActionCapabilitiesV2(
    supported: boolean,
    providerStatus: Exclude<ThreadGoalStatus, 'complete'>,
): AgentGoalCapabilitiesV2 | undefined {
    if (!supported) {
        return undefined;
    }

    const capabilities: AgentGoalCapabilitiesV2 = { clear: true, edit: true };
    if (providerStatus === 'active') {
        capabilities.pause = true;
    } else if (providerStatus === 'paused') {
        capabilities.resume = true;
    }
    return capabilities;
}

export function getCodexGoalEventThreadId(message: CodexGoalEvent): string | null {
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

    const threadId = getCodexGoalEventThreadId(message) ?? currentThreadId ?? null;
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

export function mapCodexGoalEventToAgentGoalStatusV2(
    message: CodexGoalEvent,
    currentThreadId?: string | null,
    opts?: { actionsSupported?: boolean },
): AgentGoalStatusV2 | null {
    if (message.type !== 'thread_goal_updated' && message.type !== 'thread_goal_cleared') {
        return null;
    }

    const threadId = getCodexGoalEventThreadId(message) ?? currentThreadId ?? null;
    if (!threadId) {
        return null;
    }
    if (currentThreadId && threadId !== currentThreadId) {
        return null;
    }

    if (message.type === 'thread_goal_cleared') {
        return {
            version: 2,
            ...baseStatus(threadId),
            status: 'inactive',
            reason: 'cleared',
        };
    }

    const goal = goalRecord(message.goal);
    if (!goal) {
        return {
            version: 2,
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
            version: 2,
            ...baseStatus(threadId, sourceRevision),
            status: 'inactive',
            reason: 'completed',
        };
    }

    if (!status || !ACTIVE_CODEX_GOAL_STATUSES.has(status) || !objective) {
        return {
            version: 2,
            ...baseStatus(threadId, sourceRevision),
            status: 'unavailable',
            reason: 'malformed',
        };
    }

    const providerStatus = status as Exclude<ThreadGoalStatus, 'complete'>;
    const capabilities = codexGoalActionCapabilitiesV2(
        opts?.actionsSupported === true,
        providerStatus,
    );
    return {
        version: 2,
        ...baseStatus(threadId, sourceRevision),
        status: 'active',
        text: objective,
        providerStatus,
        ...(capabilities ? { capabilities } : {}),
    };
}

/**
 * Drop duplicate response/notification projections and updates older than the
 * goal snapshot already published to the session.
 */
export function shouldApplyCodexGoalStatusV2(
    current: AgentGoalStatusV2 | undefined,
    next: AgentGoalStatusV2,
): boolean {
    if (!current || current.source !== next.source || current.sourceSessionId !== next.sourceSessionId) {
        return true;
    }

    const currentRevision = current.sourceRevision;
    const nextRevision = next.sourceRevision;
    if (typeof currentRevision === 'number' && typeof nextRevision === 'number') {
        if (nextRevision < currentRevision) {
            return false;
        }
        if (nextRevision === currentRevision) {
            return !sameCodexGoalProjection(current, next);
        }
    }
    if (currentRevision !== undefined && currentRevision === nextRevision) {
        return !sameCodexGoalProjection(current, next);
    }

    if (
        currentRevision === undefined
        && nextRevision === undefined
        && current.status === 'inactive'
        && next.status === 'inactive'
        && current.reason === next.reason
    ) {
        return false;
    }

    return true;
}

function sameCodexGoalProjection(current: AgentGoalStatusV2, next: AgentGoalStatusV2): boolean {
    if (current.status !== next.status) {
        return false;
    }
    if (current.status === 'active' && next.status === 'active') {
        return current.text === next.text
            && current.providerStatus === next.providerStatus
            && JSON.stringify(current.capabilities) === JSON.stringify(next.capabilities)
            && JSON.stringify(current.progress) === JSON.stringify(next.progress);
    }
    if (current.status === 'inactive' && next.status === 'inactive') {
        return current.reason === next.reason;
    }
    if (current.status === 'unavailable' && next.status === 'unavailable') {
        return current.reason === next.reason;
    }
    return false;
}

export function reduceCodexGoalProjection(
    current: CodexGoalProjection | undefined,
    candidate: CodexGoalProjection,
    mode: 'event' | 'persisted' = 'event',
): CodexGoalProjection {
    if (!current) {
        return candidate;
    }

    if (mode === 'persisted') {
        if (
            current.detailed.source !== candidate.detailed.source
            || current.detailed.sourceSessionId !== candidate.detailed.sourceSessionId
        ) {
            return current;
        }
        const currentRevision = current.detailed.sourceRevision;
        const candidateRevision = candidate.detailed.sourceRevision;
        if (typeof currentRevision === 'number' && typeof candidateRevision === 'number') {
            return candidateRevision > currentRevision ? candidate : current;
        }
        return current;
    }

    return shouldApplyCodexGoalStatusV2(current.detailed, candidate.detailed)
        ? candidate
        : current;
}

export function createCodexGoalInvalidationProjection(opts: {
    sourceSessionId?: string;
    observedAt?: number;
    state:
        | {
            status: 'inactive';
            reason: 'none' | 'cleared' | 'completed' | 'unknown';
        }
        | {
            status: 'unavailable';
            reason: 'unsupported' | 'not_loaded' | 'stale' | 'malformed' | 'error' | 'unknown';
        };
}): CodexGoalProjection {
    const common = {
        source: 'codex' as const,
        observedAt: opts.observedAt ?? Date.now(),
        ...(opts.sourceSessionId ? { sourceSessionId: opts.sourceSessionId } : {}),
    };
    if (opts.state.status === 'inactive') {
        return {
            legacy: {
                ...common,
                status: 'inactive',
                reason: opts.state.reason,
            },
            detailed: {
                version: 2,
                ...common,
                status: 'inactive',
                reason: opts.state.reason,
            },
        };
    }

    return {
        legacy: {
            ...common,
            status: 'unavailable',
            reason: opts.state.reason,
        },
        detailed: {
            version: 2,
            ...common,
            status: 'unavailable',
            reason: opts.state.reason,
        },
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

    const action = objective.toLowerCase();
    if (action === 'clear') {
        return { type: 'clear' };
    }
    if (action === 'pause') {
        return { type: 'set-status', status: 'paused' };
    }
    if (action === 'resume') {
        return { type: 'set-status', status: 'active' };
    }
    if (action === 'edit') {
        return { type: 'edit' };
    }

    return { type: 'set', objective };
}

export function parseCodexGoalActionParams(params: Record<string, unknown>): CodexGoalCommand | null {
    if (params.action === 'clear') {
        return { type: 'clear' };
    }

    if (params.action === 'edit') {
        const objective = nonEmptyString(params.objective);
        return objective ? { type: 'set', objective } : null;
    }

    if (params.action === 'pause') {
        return { type: 'set-status', status: 'paused' };
    }

    if (params.action === 'resume') {
        return { type: 'set-status', status: 'active' };
    }

    return null;
}
