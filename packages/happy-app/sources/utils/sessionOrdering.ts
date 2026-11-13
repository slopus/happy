/** Navigation order is independent of timeline activity and transport presence. */
export interface SessionOrderData {
    id: string;
    state?: string;
    executionPriority?: number;
    thinking?: boolean;
    agentState?: { turnStatus?: { status: string }; requests?: Record<string, unknown> | null; queuedMessages?: number } | null;
    lastUserMessageAt?: number | null;
    metadata?: { lastUserMessageAt?: number } | null;
    createdAt?: number;
}

export function getSessionExecutionPriority(session: SessionOrderData): number {
    if (session.executionPriority !== undefined) return session.executionPriority;
    return session.state === 'running' || session.state === 'permission_required'
        || session.thinking === true || session.agentState?.turnStatus?.status === 'running'
        || (session.agentState?.queuedMessages ?? 0) > 0
        || Object.keys(session.agentState?.requests ?? {}).length > 0 ? 0 : 1;
}

export function getSessionUserTime(session: SessionOrderData): number {
    return Math.max(session.lastUserMessageAt ?? 0, session.metadata?.lastUserMessageAt ?? 0) || session.createdAt || 0;
}

export function compareSessionUserTime(a: SessionOrderData, b: SessionOrderData): number {
    return getSessionUserTime(b) - getSessionUserTime(a)
        || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id);
}

export function compareSessionOrder(a: SessionOrderData, b: SessionOrderData): number {
    return getSessionExecutionPriority(a) - getSessionExecutionPriority(b) || compareSessionUserTime(a, b);
}
