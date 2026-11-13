/** Conversation recency is independent of executor presence and metadata writes. */
export function getSessionActivityTime(session: { createdAt?: number; lastMessageAt?: number | null; activityAt?: number; agentState?: { turnStatus?: { updatedAt: number } } | null }): number {
    return Math.max(session.lastMessageAt ?? 0, session.agentState?.turnStatus?.updatedAt ?? 0) || session.activityAt || session.createdAt || 0;
}

/** A delayed snapshot must not undo a message already received in this process. */
export function mergeLastMessageAt(a: number | null | undefined, b: number | null | undefined): number | null | undefined {
    if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
    if (typeof a === 'number') return a;
    if (typeof b === 'number') return b;
    return a === null || b === null ? null : undefined;
}

export function compareSessionActivity(a: { id: string; createdAt?: number; lastMessageAt?: number | null; activityAt?: number }, b: { id: string; createdAt?: number; lastMessageAt?: number | null; activityAt?: number }): number {
    return getSessionActivityTime(b) - getSessionActivityTime(a)
        || (b.createdAt ?? 0) - (a.createdAt ?? 0)
        || a.id.localeCompare(b.id);
}
