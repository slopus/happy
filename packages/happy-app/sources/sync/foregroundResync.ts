/**
 * Foreground-resume resync.
 *
 * iOS/Android suspend the websocket when the app is backgrounded, locked, or the
 * user switches apps. The server intentionally does NOT push a notification for
 * every `new-message`, so a suspended socket silently misses realtime message
 * deliveries. The metadata syncs below already refresh on resume — but before
 * this helper existed, the currently-open conversation's *messages* were never
 * re-fetched on foreground, so the open chat stayed stale until the user backed
 * out to the session list and re-entered (which fires `onSessionVisible`).
 *
 * This refreshes the global state AND the currently-visible session's messages
 * on every foreground resume. See slopus/happy#1308.
 */

/** Minimal shape of an InvalidateSync — only `.invalidate()` is needed here. */
export interface Invalidatable {
    invalidate(): void;
}

export interface ForegroundResyncDeps {
    /** Global, session-independent syncs refreshed on every foreground resume. */
    globalSyncs: Invalidatable[];
    /** The session the user currently has open, or null if none is visible. */
    currentViewingSessionId: string | null;
    /**
     * Re-fetches a session's messages (and git status). This is the per-session
     * path the suspended socket may have missed while backgrounded.
     */
    onSessionVisible: (sessionId: string) => void;
}

export function resyncOnForeground(deps: ForegroundResyncDeps): void {
    for (const sync of deps.globalSyncs) {
        sync.invalidate();
    }
    // Re-fetch the open conversation's messages so it doesn't stay stale after a
    // backgrounded socket missed realtime deliveries (slopus/happy#1308).
    if (deps.currentViewingSessionId) {
        deps.onSessionVisible(deps.currentViewingSessionId);
    }
}
