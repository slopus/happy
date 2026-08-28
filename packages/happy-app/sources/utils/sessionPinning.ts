export function sortSessionsForList<T extends { id: string; activeAt?: number; activityAt?: number; createdAt?: number; updatedAt?: number }>(
    sessions: T[],
    pinnedOrder: string[],
): T[] {
    const orderById = new Map(pinnedOrder.map((id, index) => [id, index]));

    return sessions.slice().sort((a, b) => {
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

        const bActivityTime = b.activityAt ?? (Math.max(b.activeAt ?? 0, b.updatedAt ?? 0) || b.createdAt || 0);
        const aActivityTime = a.activityAt ?? (Math.max(a.activeAt ?? 0, a.updatedAt ?? 0) || a.createdAt || 0);
        return bActivityTime - aActivityTime;
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
