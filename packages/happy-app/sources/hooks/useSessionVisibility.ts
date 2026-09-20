import * as React from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';

/**
 * Mounted is not visible: a native-stack preload must not activate a chat.
 *
 * Nor is a chat that does not exist yet. The screen is on the user's tab from
 * the press, but there is nothing to tell the server anyone is reading until
 * the machine has answered with a session.
 */
export function useSessionVisibility(sessionId: string | null, active: boolean, embedded: boolean, realtimeStatus: string) {
    const claimedView = React.useRef(false);
    React.useLayoutEffect(() => {
        if (!active || !sessionId) return;
        if (!embedded) {
            claimedView.current = true;
            storage.getState().setCurrentViewingSession(sessionId);
        }
        sync.onSessionVisible(sessionId);
    }, [sessionId, active, embedded, realtimeStatus]);

    // Keep the existing ownership while a session's info/files/changes screen
    // sits above it. Only release on unmount, and only if this instance ever
    // claimed it: discarding a preload must not clear another screen's state.
    React.useLayoutEffect(() => {
        return () => {
            if (claimedView.current && !embedded && storage.getState().currentViewingSessionId === sessionId) {
                storage.getState().setCurrentViewingSession(null);
            }
            claimedView.current = false;
        };
    }, [sessionId, embedded]);
}