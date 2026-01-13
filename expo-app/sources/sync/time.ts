let serverTimeOffsetMs = 0;

export function observeServerTimestamp(serverTimestampMs: number | null | undefined) {
    if (typeof serverTimestampMs !== 'number' || !Number.isFinite(serverTimestampMs)) {
        return;
    }
    serverTimeOffsetMs = serverTimestampMs - Date.now();
}

/**
 * Best-effort server-aligned "now" for clock-safe ordering across devices.
 * Falls back to Date.now() until we observe at least one server timestamp.
 */
export function nowServerMs(): number {
    return Date.now() + serverTimeOffsetMs;
}

