import type { AgentGoalProviderStatus, AgentGoalStatus, Session } from '@/sync/storageTypes';

export type VisibleAgentGoalStatus = {
    status: 'active';
    source: AgentGoalStatus['source'];
    observedAt: number;
    sourceSessionId: string;
    sourceRevision?: string | number;
    text: string;
    providerStatus: AgentGoalProviderStatus;
    capabilities?: {
        clear?: boolean;
        edit?: boolean;
        pause?: boolean;
        resume?: boolean;
    };
    progress?: Extract<AgentGoalStatus, { status: 'active' }>['progress'];
};

type GoalSession = Pick<Session, 'agentState' | 'presence' | 'metadata'>;

type GoalIdentity = {
    source: AgentGoalStatus['source'];
    sourceSessionId?: string;
};

type GoalFreshness = {
    observedAt: number;
    sourceRevision?: string | number;
};

function expectedSourceSessionId(session: GoalSession, source: AgentGoalStatus['source']): string | null {
    if (source === 'claude') {
        return session.metadata?.claudeSessionId ?? null;
    }
    if (source === 'codex') {
        return session.metadata?.codexThreadId ?? null;
    }
    return null;
}

function sourceIdentityMatches(session: GoalSession, goal: GoalIdentity): boolean {
    const expected = expectedSourceSessionId(session, goal.source);
    return expected !== null
        && typeof goal.sourceSessionId === 'string'
        && goal.sourceSessionId.trim().length > 0
        && goal.sourceSessionId === expected;
}

function hasSameSourceIdentity(left: GoalIdentity, right: GoalIdentity): boolean {
    return left.source === right.source
        && typeof left.sourceSessionId === 'string'
        && left.sourceSessionId === right.sourceSessionId;
}

function compareSourceRevisions(
    left: GoalFreshness['sourceRevision'],
    right: GoalFreshness['sourceRevision'],
): -1 | 0 | 1 | null {
    if (typeof left === 'number' && Number.isFinite(left)
        && typeof right === 'number' && Number.isFinite(right)) {
        return left === right ? 0 : left > right ? 1 : -1;
    }
    if (typeof left === 'string' && typeof right === 'string' && left === right) {
        return 0;
    }
    return null;
}

function isFirstClearlyNewer(first: GoalFreshness, second: GoalFreshness): boolean {
    const revisionOrder = compareSourceRevisions(first.sourceRevision, second.sourceRevision);
    if (revisionOrder !== null) {
        if (revisionOrder !== 0) {
            return revisionOrder > 0;
        }
    }
    return first.observedAt > second.observedAt;
}

function visibleGoalFromV1(goal: AgentGoalStatus | null): VisibleAgentGoalStatus | null {
    if (!goal || goal.status !== 'active') {
        return null;
    }

    return {
        status: 'active',
        source: goal.source,
        observedAt: goal.observedAt,
        sourceSessionId: goal.sourceSessionId,
        sourceRevision: goal.sourceRevision,
        text: goal.text,
        providerStatus: 'active',
        capabilities: goal.capabilities ? {
            clear: goal.capabilities.clear,
            edit: goal.capabilities.edit,
        } : undefined,
        progress: goal.progress,
    };
}

export function resolveVisibleAgentGoalStatus(session: GoalSession): VisibleAgentGoalStatus | null {
    if (session.presence !== 'online') {
        return null;
    }

    const goalV1 = session.agentState?.agentGoalStatus ?? null;
    const currentGoalV1 = goalV1 && sourceIdentityMatches(session, goalV1)
        ? goalV1
        : null;
    const visibleGoalV1 = visibleGoalFromV1(currentGoalV1);

    const goalV2 = session.agentState?.agentGoalStatusV2 ?? null;
    const currentGoalV2 = goalV2 && sourceIdentityMatches(session, goalV2)
        ? goalV2
        : null;

    // A V2 projection from a previous provider thread must never hide the
    // current V1 projection while session metadata is changing or reconnecting.
    if (!currentGoalV2) {
        return visibleGoalV1;
    }

    if (currentGoalV1 && hasSameSourceIdentity(currentGoalV1, currentGoalV2)) {
        const staleV2 = currentGoalV2.status === 'unavailable'
            && currentGoalV2.reason === 'stale';
        if (staleV2 || isFirstClearlyNewer(currentGoalV1, currentGoalV2)) {
            return visibleGoalV1;
        }
    }

    if (currentGoalV2.status !== 'active') {
        return null;
    }

    return currentGoalV2;
}
