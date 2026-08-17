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
