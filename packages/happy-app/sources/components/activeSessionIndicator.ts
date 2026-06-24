import { type SessionState } from '@/utils/sessionUtils';

export type LeadingSessionIndicatorKind =
    | 'unread_notification'
    | 'draft'
    | 'activity_dot'
    | 'idle_dot'
    | null;

export interface LeadingSessionIndicatorInput {
    state: SessionState;
    hasUnread: boolean;
    hasDraft: boolean;
}

/**
 * Chooses the compact active-session leading indicator.
 *
 * Unread/waiting-for-user sessions need to be more obvious than the same tiny
 * status dot used for background activity. Keep this as a pure helper so the
 * visual priority is covered by tests instead of by wishful squinting.
 */
export function getLeadingSessionIndicatorKind(session: LeadingSessionIndicatorInput): LeadingSessionIndicatorKind {
    if (session.hasUnread) {
        return 'unread_notification';
    }

    if (session.state === 'waiting' && session.hasDraft) {
        return 'draft';
    }

    if (session.state === 'permission_required' || session.state === 'thinking') {
        return 'activity_dot';
    }

    if (session.state === 'waiting') {
        return 'idle_dot';
    }

    return null;
}
