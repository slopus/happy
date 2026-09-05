import { describe, expect, it } from 'vitest';
import { SessionMessageRetention } from './sessionMessageRetention';

describe('SessionMessageRetention', () => {
    it('evicts exactly the least recently used session when a fourth is touched', () => {
        const retention = new SessionMessageRetention(3);
        expect(retention.touch('session-a')).toEqual([]);
        expect(retention.touch('session-b')).toEqual([]);
        expect(retention.touch('session-c')).toEqual([]);

        expect(retention.touch('session-d')).toEqual(['session-a']);
        expect(retention.retainedSessionIds()).toEqual(['session-b', 'session-c', 'session-d']);
    });

    it('updates recency when an already retained session is touched', () => {
        const retention = new SessionMessageRetention(3);
        retention.touch('session-a');
        retention.touch('session-b');
        retention.touch('session-c');
        retention.touch('session-a');

        expect(retention.touch('session-d')).toEqual(['session-b']);
        expect(retention.retainedSessionIds()).toEqual(['session-c', 'session-a', 'session-d']);
    });

    it('forgets a released cache without evicting another retained session', () => {
        const retention = new SessionMessageRetention(3);
        retention.touch('session-a');
        retention.touch('session-b');
        retention.touch('session-c');

        retention.remove('session-b');

        expect(retention.touch('session-d')).toEqual([]);
        expect(retention.retainedSessionIds()).toEqual(['session-a', 'session-c', 'session-d']);
    });
});
