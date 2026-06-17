import type { AgentGoalStatus, Session } from '@/sync/storageTypes';

export type VisibleAgentGoalStatus = AgentGoalStatus & { status: 'active'; text: string; sourceSessionId: string };

type GoalSession = Pick<Session, 'agentState' | 'presence' | 'metadata'>;

function expectedSourceSessionId(session: GoalSession, source: AgentGoalStatus['source']): string | null {
    if (source === 'claude') {
        return session.metadata?.claudeSessionId ?? null;
    }
    if (source === 'codex') {
        return session.metadata?.codexThreadId ?? null;
    }
    return null;
}

function sourceIdentityMatches(session: GoalSession, goal: VisibleAgentGoalStatus): boolean {
    const expected = expectedSourceSessionId(session, goal.source);
    return expected !== null
        && typeof goal.sourceSessionId === 'string'
        && goal.sourceSessionId.trim().length > 0
        && goal.sourceSessionId === expected;
}

export function resolveVisibleAgentGoalStatus(session: GoalSession): VisibleAgentGoalStatus | null {
    const goal = session.agentState?.agentGoalStatus;
    if (!goal || goal.status !== 'active') {
        return null;
    }

    if (session.presence !== 'online') {
        return null;
    }

    if (!sourceIdentityMatches(session, goal)) {
        return null;
    }

    return goal;
}
