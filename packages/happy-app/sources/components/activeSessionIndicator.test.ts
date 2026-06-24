import { describe, expect, it } from 'vitest';
import { getLeadingSessionIndicatorKind } from './activeSessionIndicator';

describe('getLeadingSessionIndicatorKind', () => {
    it('uses a notification-style indicator for unread sessions instead of a plain status dot', () => {
        expect(getLeadingSessionIndicatorKind({
            state: 'waiting',
            hasUnread: true,
            hasDraft: false,
        })).toBe('unread_notification');
    });

    it('keeps the blinking activity dot for sessions that are still working', () => {
        expect(getLeadingSessionIndicatorKind({
            state: 'thinking',
            hasUnread: false,
            hasDraft: false,
        })).toBe('activity_dot');
    });

    it('keeps draft and idle states distinct', () => {
        expect(getLeadingSessionIndicatorKind({
            state: 'waiting',
            hasUnread: false,
            hasDraft: true,
        })).toBe('draft');

        expect(getLeadingSessionIndicatorKind({
            state: 'waiting',
            hasUnread: false,
            hasDraft: false,
        })).toBe('idle_dot');
    });
});
