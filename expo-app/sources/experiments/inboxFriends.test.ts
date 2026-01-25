import { describe, expect, it } from 'vitest';
import { isInboxFriendsEnabled } from './inboxFriends';

describe('isInboxFriendsEnabled', () => {
    it('returns false when experiments master switch is off', () => {
        expect(isInboxFriendsEnabled({ experiments: false, expInboxFriends: true })).toBe(false);
        expect(isInboxFriendsEnabled({ experiments: false, expInboxFriends: false })).toBe(false);
    });

    it('returns false when inbox/friends toggle is off', () => {
        expect(isInboxFriendsEnabled({ experiments: true, expInboxFriends: false })).toBe(false);
    });

    it('returns true when both toggles are on', () => {
        expect(isInboxFriendsEnabled({ experiments: true, expInboxFriends: true })).toBe(true);
    });
});

