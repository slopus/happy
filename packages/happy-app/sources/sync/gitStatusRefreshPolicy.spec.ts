import { describe, expect, it } from 'vitest';

import {
    decideNotGitRefreshOutcome,
    shouldInvalidateGitStatusOnActivityTransition,
} from './gitStatusRefreshPolicy';

describe('gitStatusRefreshPolicy', () => {
    describe('shouldInvalidateGitStatusOnActivityTransition', () => {
        it('invalidates when a known session recovers from offline to online', () => {
            expect(shouldInvalidateGitStatusOnActivityTransition(false, true)).toBe(true);
        });

        it('does not invalidate for steady online heartbeats', () => {
            expect(shouldInvalidateGitStatusOnActivityTransition(true, true)).toBe(false);
        });

        it('does not invalidate when there is no prior offline state', () => {
            expect(shouldInvalidateGitStatusOnActivityTransition(undefined, true)).toBe(false);
        });
    });

    describe('decideNotGitRefreshOutcome', () => {
        it('preserves previous git status on the first non-git result for a known git project', () => {
            expect(decideNotGitRefreshOutcome({
                hasConfirmedGitRepo: true,
                consecutiveNotGitDetections: 0,
            })).toEqual({
                action: 'preserve',
                nextConsecutiveNotGitDetections: 1,
            });
        });

        it('clears status after repeated non-git results for a known git project', () => {
            expect(decideNotGitRefreshOutcome({
                hasConfirmedGitRepo: true,
                consecutiveNotGitDetections: 1,
            })).toEqual({
                action: 'clear',
                nextConsecutiveNotGitDetections: 2,
            });
        });

        it('clears immediately for projects that were never confirmed as git repositories', () => {
            expect(decideNotGitRefreshOutcome({
                hasConfirmedGitRepo: false,
                consecutiveNotGitDetections: 0,
            })).toEqual({
                action: 'clear',
                nextConsecutiveNotGitDetections: 1,
            });
        });
    });
});
