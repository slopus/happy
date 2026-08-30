export interface SessionAttentionState {
    presence?: string | number | null;
    agentState?: {
        requests?: Record<string, unknown> | null;
    } | null;
}

/**
 * Counts sessions that currently need the user's attention.
 * A session with both an unread update and a pending request is counted once.
 */
export function getSessionAttentionBadgeCount(
    sessions: Record<string, SessionAttentionState>,
    unreadSessionIds: ReadonlySet<string>,
): number {
    const attentionSessionIds = new Set(unreadSessionIds);

    for (const [sessionId, session] of Object.entries(sessions)) {
        const pendingRequestCount = Object.keys(session.agentState?.requests ?? {}).length;
        if (session.presence === 'online' && pendingRequestCount > 0) {
            attentionSessionIds.add(sessionId);
        }
    }

    return attentionSessionIds.size;
}

export function shouldMarkSessionEventUnread(
    appState: string,
    currentViewingSessionId: string | null,
    eventSessionId: string,
): boolean {
    return appState !== 'active' || currentViewingSessionId !== eventSessionId;
}
