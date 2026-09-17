import * as React from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';

/** Mounted is not visible: a native-stack preload must not activate a chat. */
export function useSessionVisibility(sessionId: string, active: boolean, embedded: boolean, realtimeStatus: string) {
    const claimedView = React.useRef(false);
    React.useLayoutEffect(() => {
        if (!active) return;
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
            if (claimedView.current && !embedded) {
                if (storage.getState().currentViewingSessionId === sessionId) {
                    storage.getState().setCurrentViewingSession(null);
                }
                // The screen is gone: sync may now release chats that fell out
                // of its recently viewed window (never the one still on screen).
                sync.onSessionHidden(sessionId);
            }
            claimedView.current = false;
        };
    }, [sessionId, embedded]);
}