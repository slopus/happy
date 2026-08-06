import { useUnistyles } from 'react-native-unistyles';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { buildResumeCommand, buildResumeCommandBlock, ResumeCommandBlock } from './resumeCommand';

export type SessionState = 'idle' | 'running' | 'permission_required' | 'failed' | 'completed';

export interface ResolvedSessionState {
    state: SessionState;
    isConnected: boolean;
}

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

export function getSessionStateLabel(state: SessionState): string {
    return {
        idle: t('status.idle'),
        running: t('status.running'),
        permission_required: t('status.permissionRequired'),
        failed: t('status.failed'),
        completed: t('status.completed'),
    }[state];
}

export function resolveSessionState(session: Pick<Session, 'agentState' | 'presence' | 'thinking'>): ResolvedSessionState {
    const isOnline = session.presence === "online";
    const hasPermissions = !!(session.agentState?.requests && Object.keys(session.agentState.requests).length > 0);
    if (hasPermissions) {
        return { state: 'permission_required', isConnected: isOnline };
    }
    const persisted = session.agentState?.turnStatus?.status;
    if (isOnline && (session.thinking === true || persisted === 'running')) {
        return { state: 'running', isConnected: true };
    }
    if (persisted === 'failed') {
        return { state: 'failed', isConnected: isOnline };
    }
    if (persisted === 'completed') {
        return { state: 'completed', isConnected: isOnline };
    }
    return { state: 'idle', isConnected: isOnline };
}

/** Resolve the canonical five-state outcome plus an orthogonal connection state. */
export function useSessionStatus(session: Session): SessionStatus {
    const { theme } = useUnistyles();
    const resolved = resolveSessionState(session);
    const colors: Record<SessionState, string> = {
        idle: resolved.isConnected ? '#34C759' : '#999999',
        running: theme.colors.accent,
        permission_required: '#FF9500',
        failed: '#FF3B30',
        completed: '#34C759',
    };
    const offlineText = resolved.isConnected
        ? ''
        : ` · ${t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) })}`;

    return {
        ...resolved,
        statusText: `${getSessionStateLabel(resolved.state)}${offlineText}`,
        shouldShowStatus: true,
        statusColor: colors[resolved.state],
        statusDotColor: colors[resolved.state],
        isPulsing: resolved.state === 'running' || resolved.state === 'permission_required',
    };
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: Session): string {
    if (session.metadata?.summary) {
        return session.metadata.summary.text;
    }
    return t('session.newChat');
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: Session): string {
    if (session.metadata?.machineId && session.metadata?.path) {
        // Combine machine ID and path for a unique, deterministic avatar
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }
    // Fallback to session ID if metadata is missing
    return session.id;
}

/**
 * Returns the CLI command to resume a disconnected session, or null if not resumable.
 * Uses flavor-specific commands which work without happy-agent auth.
 */
export function getResumeCommand(session: Session): string | null {
    return buildResumeCommand(session.metadata ?? {});
}

export function getResumeCommandBlock(session: Session): ResumeCommandBlock | null {
    return buildResumeCommandBlock(session.metadata ?? {});
}

/**
 * Formats a path relative to home directory if possible.
 * If the path starts with the home directory, replaces it with ~
 * Otherwise returns the full path.
 */
export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;
    
    // Normalize paths to handle trailing slashes
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    const normalizedPath = path;
    
    // Check if path starts with home directory
    if (normalizedPath.startsWith(normalizedHome)) {
        // Replace home directory with ~
        const relativePath = normalizedPath.slice(normalizedHome.length);
        // Add ~ and ensure there's a / after it if needed
        if (relativePath.startsWith('/')) {
            return '~' + relativePath;
        } else if (relativePath === '') {
            return '~';
        } else {
            return '~/' + relativePath;
        }
    }
    
    return path;
}

/**
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: Session): string {
    if (session.metadata) {
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }
    return t('status.unknown');
}

/**
 * Checks if a session is currently online based on the active flag.
 * A session is considered online if the active flag is true.
 */
export function isSessionOnline(session: Session): boolean {
    return session.active;
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the active flag directly.
 */
export function isSessionActive(session: Session): boolean {
    return session.active;
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
 * @param activeAt - Timestamp when the session was last active
 * @param isActive - Whether the session is currently active
 * @returns Formatted string like "Active now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(activeAt: number, isActive: boolean = false): string {
    if (isActive) {
        return t('status.activeNow');
    }

    const now = Date.now();
    const diffMs = now - activeAt;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
        return t('time.justNow');
    } else if (diffMinutes < 60) {
        return t('time.minutesAgo', { count: diffMinutes });
    } else if (diffHours < 24) {
        return t('time.hoursAgo', { count: diffHours });
    } else if (diffDays < 7) {
        return t('sessionHistory.daysAgo', { count: diffDays });
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

export const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];
