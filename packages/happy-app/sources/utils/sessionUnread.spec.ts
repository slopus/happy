import { describe, expect, it } from 'vitest';
import { unreadMayOverride } from './sessionUnread';
import type { SessionState } from './sessionUtils';

describe('unreadMayOverride', () => {
    // The case this exists for. A session blocked on a permission prompt or an
    // open question makes no progress until someone answers it, and unread used
    // to paint over that: the row read "new results" while the session sat
    // waiting, with nothing saying to open it.
    it('does not let unread hide a session that is blocked on the user', () => {
        expect(unreadMayOverride('permission_required')).toBe(false);
    });

    // Milder, since both render blue: unread only costs the pulse. Still a live
    // state describing work in flight, so the live state wins.
    it('does not let unread hide work in progress', () => {
        expect(unreadMayOverride('thinking')).toBe(false);
    });

    it('lets unread show once the session is idle or gone', () => {
        expect(unreadMayOverride('waiting')).toBe(true);
        expect(unreadMayOverride('disconnected')).toBe(true);
    });

    // An allowlist, so a state added later keeps its own display until someone
    // decides otherwise. If this fails because a state was added, decide
    // deliberately whether unread may stand in for it.
    it('covers every state, and defaults an unknown one to keeping its display', () => {
        const states: SessionState[] = [
            'disconnected',
            'thinking',
            'waiting',
            'permission_required',
        ];
        expect(states.filter(unreadMayOverride)).toEqual(['disconnected', 'waiting']);
        expect(unreadMayOverride('needs_input' as SessionState)).toBe(false);
    });
});
