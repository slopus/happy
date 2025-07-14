import { Session } from '@/sync/types';

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: Session): string {
    if (session.metadata?.path) {
        const segments = session.metadata.path.split('/').filter(Boolean);
        return segments.pop() || 'unknown';
    }
    return 'unknown';
}

/**
 * Checks if a session is currently online based on active flag and last active time.
 * A session is considered online if it's active and was active within the last 10 minutes.
 */
export function isSessionOnline(session: Session, timeoutMs: number = 10 * 60 * 1000): boolean {
    return session.active && session.activeAt > Date.now() - timeoutMs;
}

/**
 * Formats the last seen time of a session into a human-readable relative time.
 * @param active - Whether the session is currently active
 * @param activeAt - Timestamp when the session was last active
 * @returns Formatted string like "just now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(active: boolean, activeAt: number): string {
    if (active) {
        return 'Active now';
    }

    const now = Date.now();
    const diffMs = now - activeAt;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
        return 'just now';
    } else if (diffMinutes < 60) {
        return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
        return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
        return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else {
        // Format as date
        const date = new Date(activeAt);
        const options: Intl.DateTimeFormatOptions = {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        };
        return date.toLocaleDateString(undefined, options);
    }
}