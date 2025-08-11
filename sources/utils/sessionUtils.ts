import * as React from 'react';
import { Session } from '@/sync/storageTypes';

// Timeout for considering a session disconnected (30 seconds)
export const DISCONNECTED_TIMEOUT_MS = 30000;

// Timeout for considering a session idle (30 seconds)
export const IDLE_TIMEOUT_MS = 30000;

export type SessionState = 'disconnected' | 'thinking' | 'waiting' | 'idle' | 'permission_required';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

/**
 * Get the current state of a session based on activeAt and thinking status.
 * This centralizes the logic for determining session state across the app.
 */
export function useSessionStatus(session: Session): SessionStatus {

    const now = Date.now();
    const isDisconnected = !session.activeAt || session.activeAt < now - DISCONNECTED_TIMEOUT_MS;
    const isIdle = !isDisconnected && session.activeAt < now - IDLE_TIMEOUT_MS;
    const hasPermissions = (session.agentState?.requests && Object.keys(session.agentState.requests).length > 0 ? true : false);

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)] + '…';
    }, [isDisconnected, hasPermissions, session.thinking]);

    if (isDisconnected) {
        return {
            state: 'disconnected',
            isConnected: false,
            statusText: `last seen ${formatLastSeen(session.activeAt)}`,
            shouldShowStatus: true,
            statusColor: '#999',
            statusDotColor: '#999'
        };
    }

    // Check if permission is required (controlledByUser is true)
    if (hasPermissions) {
        return {
            state: 'permission_required',
            isConnected: true,
            statusText: 'permission required',
            shouldShowStatus: true,
            statusColor: '#FF9500',
            statusDotColor: '#FF9500',
            isPulsing: true
        };
    }

    if (session.thinking === true) {
        return {
            state: 'thinking',
            isConnected: true,
            statusText: vibingMessage,
            shouldShowStatus: true,
            statusColor: '#007AFF',
            statusDotColor: '#007AFF',
            isPulsing: true
        };
    }

    if (isIdle) {
        return {
            state: 'idle',
            isConnected: true,
            statusText: 'idle',
            shouldShowStatus: true,
            statusColor: '#666',
            statusDotColor: '#666'
        };
    }

    return {
        state: 'waiting',
        isConnected: true,
        statusText: '',
        shouldShowStatus: false,
        statusColor: '#34C759',
        statusDotColor: '#34C759'
    };
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: Session): string {
    if (session.metadata?.summary) {
        return session.metadata.summary.text;
    } else if (session.metadata) {
        const segments = session.metadata.path.split('/').filter(Boolean);
        const lastSegment = segments.pop()!;
        return lastSegment;
    }
    return 'unknown';
}

/**
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: Session): string {
    if (session.metadata) {
        return session.metadata.path;
    }
    return 'unknown';
}

/**
 * Checks if a session is currently online based on the presence field.
 * A session is considered online if presence is "online".
 * Note: This uses the 10-minute timeout. For UI consistency with
 * disconnected state, consider using getSessionState().isConnected instead.
 */
export function isSessionOnline(session: Session): boolean {
    return session.presence === "online";
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the same 5-second timeout as the disconnected state.
 */
export function isSessionActive(session: Session): boolean {
    const now = Date.now();
    return !!session.activeAt && (session.activeAt >= now - DISCONNECTED_TIMEOUT_MS);
}

/**
 * Formats OS platform string into a more readable format
 */
export function formatOSPlatform(platform?: string): string {
    if (!platform) return '';

    const osMap: Record<string, string> = {
        'darwin': 'macOS',
        'win32': 'Windows',
        'linux': 'Linux',
        'android': 'Android',
        'ios': 'iOS',
        'aix': 'AIX',
        'freebsd': 'FreeBSD',
        'openbsd': 'OpenBSD',
        'sunos': 'SunOS'
    };

    return osMap[platform.toLowerCase()] || platform;
}

/**
 * Formats the last seen time of a session into a human-readable relative time.
 * @param presence - Session presence ("online" or timestamp)
 * @returns Formatted string like "Active now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(presence: "online" | number): string {
    if (presence === "online") {
        return 'Active now';
    }

    const now = Date.now();
    const diffMs = now - presence;
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
        const date = new Date(presence);
        const options: Intl.DateTimeFormatOptions = {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        };
        return date.toLocaleDateString(undefined, options);
    }
}

const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];