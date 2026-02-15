import { useRef, useEffect } from 'react';
import { useElapsedTime } from './useElapsedTime';
import { SessionState } from '@/utils/sessionUtils';

const ACTIVE_STATES: SessionState[] = ['thinking', 'permission_required'];

/**
 * Tracks elapsed time since a session entered an active state (thinking/permission_required).
 * Returns formatted elapsed string (e.g. "12s", "1m 23s") or null when inactive.
 * Uses client-side timing — resets if component remounts.
 */
export function useActivityTimer(state: SessionState): string | null {
    const startedAtRef = useRef<number | null>(null);
    const isActive = ACTIVE_STATES.includes(state);

    // Capture timestamp on transition to active state
    useEffect(() => {
        if (isActive && startedAtRef.current === null) {
            startedAtRef.current = Date.now();
        } else if (!isActive) {
            startedAtRef.current = null;
        }
    }, [isActive]);

    const elapsed = useElapsedTime(isActive ? startedAtRef.current : null);

    if (!isActive || elapsed < 1) {
        return null;
    }

    return formatElapsed(elapsed);
}

function formatElapsed(seconds: number): string {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
}
