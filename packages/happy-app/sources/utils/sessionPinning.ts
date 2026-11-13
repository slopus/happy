import { compareSessionUserTime, getSessionExecutionPriority, type SessionOrderData } from './sessionOrdering';

export function sortSessionsForList<T extends SessionOrderData>(
    sessions: T[],
    pinnedOrder: string[],
): T[] {
    const orderById = new Map(pinnedOrder.map((id, index) => [id, index]));

    return sessions.slice().sort((a, b) => {
        const priority = getSessionExecutionPriority(a) - getSessionExecutionPriority(b);
        if (priority) return priority;
        const aPinnedIndex = orderById.get(a.id);
        const bPinnedIndex = orderById.get(b.id);

        if (aPinnedIndex != null && bPinnedIndex != null) {
            return aPinnedIndex - bPinnedIndex;
        }
        if (aPinnedIndex != null) {
            return -1;
        }
        if (bPinnedIndex != null) {
            return 1;
        }

        return compareSessionUserTime(a, b);
    });
}

export function partitionSessionsByPinnedOrder<T extends { id: string }>(
    sessions: T[],
    pinnedOrder: string[],
): { pinned: T[]; regular: T[] } {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const pinned = pinnedOrder
        .map((sessionId) => sessionsById.get(sessionId))
        .filter((session): session is T => session !== undefined);
    const pinnedIds = new Set(pinned.map((session) => session.id));

    return {
        pinned,
        regular: sessions.filter((session) => !pinnedIds.has(session.id)),
    };
}
