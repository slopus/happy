import type { SessionState } from '@/sync/sessionState';
import { APP_ACCENT_BLUE } from '@/theme';

export const SESSION_READY_DOT_COLOR = APP_ACCENT_BLUE;
export const SESSION_BLOCKED_DOT_COLOR = '#FF9500';

export type FlatSessionRowTopRight =
    | { type: 'dot'; color: string }
    | { type: 'timestamp' };

/**
 * Keeps the flat row's two progress signals mutually exclusive: active work is
 * carried by the title shimmer, while only something the user should notice
 * replaces the ordinary timestamp with a Telegram-sized dot.
 */
export function resolveFlatSessionRowPresentation({
    state,
    hasUnread,
    faded,
    unreadDotColor = SESSION_READY_DOT_COLOR,
}: {
    state: SessionState;
    hasUnread: boolean;
    faded: boolean;
    unreadDotColor?: string;
}): {
    shimmerTitle: boolean;
    topRight: FlatSessionRowTopRight;
} {
    if (faded) {
        return { shimmerTitle: false, topRight: { type: 'timestamp' } };
    }

    if (state === 'permission_required' || state === 'input_required') {
        return {
            shimmerTitle: false,
            topRight: { type: 'dot', color: SESSION_BLOCKED_DOT_COLOR },
        };
    }

    if (state === 'thinking') {
        return { shimmerTitle: true, topRight: { type: 'timestamp' } };
    }

    if (hasUnread) {
        return {
            shimmerTitle: false,
            topRight: { type: 'dot', color: unreadDotColor },
        };
    }

    return { shimmerTitle: false, topRight: { type: 'timestamp' } };
}