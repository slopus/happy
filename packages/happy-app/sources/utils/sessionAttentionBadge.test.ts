import { describe, expect, it } from 'vitest';
import { getSessionAttentionBadgeCount, shouldMarkSessionEventUnread } from './sessionAttentionBadge';

describe('getSessionAttentionBadgeCount', () => {
    it('counts online sessions with pending confirmation requests', () => {
        expect(getSessionAttentionBadgeCount({
            needsConfirmation: {
                presence: 'online',
                agentState: { requests: { tool: {} } },
            },
            disconnected: {
                presence: 'offline',
                agentState: { requests: { tool: {} } },
            },
        }, new Set())).toBe(1);
    });

    it('counts unread updates and does not double-count a session needing confirmation', () => {
        expect(getSessionAttentionBadgeCount({
            completed: { presence: 'online' },
            needsConfirmation: {
                presence: 'online',
                agentState: { requests: { tool: {} } },
            },
        }, new Set(['completed', 'needsConfirmation']))).toBe(2);
    });

    it('keeps unread sessions counted after they disconnect', () => {
        expect(getSessionAttentionBadgeCount({
            completed: { presence: 1_725_000_000_000 },
        }, new Set(['completed']))).toBe(1);
    });
});

describe('shouldMarkSessionEventUnread', () => {
    it('does not mark an event already visible in the active session', () => {
        expect(shouldMarkSessionEventUnread('active', 'session-1', 'session-1')).toBe(false);
    });

    it('marks another session or a backgrounded current session unread', () => {
        expect(shouldMarkSessionEventUnread('active', 'session-1', 'session-2')).toBe(true);
        expect(shouldMarkSessionEventUnread('background', 'session-1', 'session-1')).toBe(true);
    });
});
