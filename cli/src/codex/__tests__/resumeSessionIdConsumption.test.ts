import { describe, expect, it } from 'vitest';
import { nextStoredSessionIdForResumeAfterAttempt } from '../runCodex';

describe('nextStoredSessionIdForResumeAfterAttempt', () => {
    it('keeps stored resume id when resume fails', () => {
        expect(nextStoredSessionIdForResumeAfterAttempt('abc', { attempted: true, success: false })).toBe('abc');
    });

    it('consumes stored resume id only when resume succeeds', () => {
        expect(nextStoredSessionIdForResumeAfterAttempt('abc', { attempted: true, success: true })).toBe(null);
    });

    it('does not consume stored resume id when no resume attempt was made', () => {
        expect(nextStoredSessionIdForResumeAfterAttempt('abc', { attempted: false, success: true })).toBe('abc');
    });
});

