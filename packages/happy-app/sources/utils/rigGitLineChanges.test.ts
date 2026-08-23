import { describe, expect, it } from 'vitest';

import { visibleRigGitLineChanges } from './rigGitLineChanges';

describe('visibleRigGitLineChanges', () => {
    it('shows nonzero additions and deletions with exactness preserved', () => {
        expect(visibleRigGitLineChanges({
            changedFiles: 3,
            countsExact: true,
            deletions: 12,
            insertions: 45,
        })).toEqual({ approximate: false, deletions: 12, insertions: 45 });
    });

    it('marks estimated counts and hides a clean comparison', () => {
        expect(visibleRigGitLineChanges({
            changedFiles: 2,
            countsExact: false,
            deletions: 0,
            insertions: 9,
        })).toEqual({ approximate: true, deletions: 0, insertions: 9 });
        expect(visibleRigGitLineChanges({
            changedFiles: 0,
            countsExact: true,
            deletions: 0,
            insertions: 0,
        })).toBeNull();
    });
});
