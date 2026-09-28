import * as React from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';

const RESULT_RECOVERY_INTERVAL_MS = 5_000;

/**
 * Subscribe only the open conversation to the gap between its known latest
 * message sequence and the latest contiguous sequence committed to its list.
 * Older-history windows and caches without a verified baseline do not imply
 * pending results; loading old messages must not change completion feedback.
 */
export function useSessionResultSyncing(sessionId: string, recover = false): boolean {
    const isSyncing = storage((state) => {
        const cache = state.sessionMessages[sessionId];
        const session = state.sessions[sessionId];
        return !!(session && cache?.isLoaded && cache.isAtLatest !== false
            && typeof cache.latestAppliedSeq === 'number'
            && session.seq > cache.latestAppliedSeq);
    });

    React.useEffect(() => {
        if (!recover || !isSyncing) return;
        // Realtime delivery can announce completion while the transcript still
        // has a gap. Keep the open conversation moving even if the last socket
        // event was lost or a previous forward fetch made no progress.
        const catchUp = () => { void sync.ensureMessagesLoaded(sessionId).catch(console.warn); };
        catchUp();
        const timer = setInterval(catchUp, RESULT_RECOVERY_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [sessionId, recover, isSyncing]);

    return isSyncing;
}
