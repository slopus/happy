export type SessionCapacityReservation = {
    commit(): void;
    release(): void;
};

export function createSessionCapacityLimiter({
    maxConcurrentSessions,
    countActiveSessions,
}: {
    maxConcurrentSessions?: number;
    countActiveSessions: () => number;
}) {
    let pendingReservations = 0;

    return {
        tryReserve(): SessionCapacityReservation | null {
            if (
                maxConcurrentSessions !== undefined
                && countActiveSessions() + pendingReservations >= maxConcurrentSessions
            ) {
                return null;
            }

            pendingReservations += 1;
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                pendingReservations -= 1;
            };

            return {
                // The caller commits only after the process has been inserted into
                // the tracked-session map, which takes over capacity accounting.
                commit: settle,
                release: settle,
            };
        },
        pendingCount(): number {
            return pendingReservations;
        },
    };
}

export function sessionCapacityError(maxConcurrentSessions: number): string {
    return `Daemon session limit reached (${maxConcurrentSessions}). Stop or wait for an existing daemon session before starting another.`;
}
