import { describe, expect, it } from 'vitest';

import { compactCount, visibleRigGitLineChanges } from './rigGitLineChanges';

describe('compactCount', () => {
    it('keeps counts below one thousand exact', () => {
        expect(compactCount(0)).toBe('0');
        expect(compactCount(842)).toBe('842');
        expect(compactCount(999)).toBe('999');
    });

    it('uses useful tenths below five thousand', () => {
        expect(compactCount(1_000)).toBe('1k');
        expect(compactCount(1_200)).toBe('1.2k');
        expect(compactCount(4_038)).toBe('4k');
        expect(compactCount(4_238)).toBe('4.2k');
        expect(compactCount(4_950)).toBe('5k');
    });

    it('rounds larger counts to whole thousands', () => {
        expect(compactCount(5_300)).toBe('5k');
        expect(compactCount(12_800)).toBe('13k');
    });
});

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
