import { describe, expect, it } from 'vitest';
import { computeHasUnreadActivity } from './unread';

describe('computeHasUnreadActivity', () => {
    it('returns false when there is no activity', () => {
        expect(
            computeHasUnreadActivity({
                sessionSeq: 0,
                pendingActivityAt: 0,
                lastViewedSessionSeq: undefined,
                lastViewedPendingActivityAt: undefined,
            })
        ).toBe(false);
    });

    it('treats missing read marker as unread when there is activity', () => {
        expect(
            computeHasUnreadActivity({
                sessionSeq: 1,
                pendingActivityAt: 0,
                lastViewedSessionSeq: undefined,
                lastViewedPendingActivityAt: undefined,
            })
        ).toBe(true);
        expect(
            computeHasUnreadActivity({
                sessionSeq: 0,
                pendingActivityAt: 123,
                lastViewedSessionSeq: undefined,
                lastViewedPendingActivityAt: undefined,
            })
        ).toBe(true);
    });

    it('returns true when sessionSeq advanced beyond marker', () => {
        expect(
            computeHasUnreadActivity({
                sessionSeq: 11,
                pendingActivityAt: 0,
                lastViewedSessionSeq: 10,
                lastViewedPendingActivityAt: 0,
            })
        ).toBe(true);
    });

    it('returns true when pending activity advanced beyond marker', () => {
        expect(
            computeHasUnreadActivity({
                sessionSeq: 0,
                pendingActivityAt: 11,
                lastViewedSessionSeq: 0,
                lastViewedPendingActivityAt: 10,
            })
        ).toBe(true);
    });

    it('returns false when activity is not beyond marker', () => {
        expect(
            computeHasUnreadActivity({
                sessionSeq: 11,
                pendingActivityAt: 11,
                lastViewedSessionSeq: 11,
                lastViewedPendingActivityAt: 11,
            })
        ).toBe(false);
    });
});
