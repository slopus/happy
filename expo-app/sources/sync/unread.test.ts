import { describe, expect, it } from 'vitest';
import { hasUnreadMessages } from './unread';

describe('hasUnreadMessages', () => {
    it('returns false when lastViewedAt is missing', () => {
        expect(hasUnreadMessages({ lastViewedAt: undefined, messages: [{ createdAt: 10 }] })).toBe(false);
    });

    it('returns false when there are no messages', () => {
        expect(hasUnreadMessages({ lastViewedAt: 10, messages: [] })).toBe(false);
        expect(hasUnreadMessages({ lastViewedAt: 10, messages: null })).toBe(false);
    });

    it('returns true when newest message is after lastViewedAt (ascending)', () => {
        expect(
            hasUnreadMessages({
                lastViewedAt: 10,
                messages: [{ createdAt: 5 }, { createdAt: 11 }],
            }),
        ).toBe(true);
    });

    it('returns true when newest message is after lastViewedAt (descending)', () => {
        expect(
            hasUnreadMessages({
                lastViewedAt: 10,
                messages: [{ createdAt: 11 }, { createdAt: 5 }],
            }),
        ).toBe(true);
    });

    it('returns false when newest message is not after lastViewedAt', () => {
        expect(
            hasUnreadMessages({
                lastViewedAt: 11,
                messages: [{ createdAt: 11 }, { createdAt: 5 }],
            }),
        ).toBe(false);
    });
});

