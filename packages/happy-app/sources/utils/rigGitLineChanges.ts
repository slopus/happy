import type { RigGitSummary } from '@/sync/rig';

export type VisibleRigGitLineChanges = {
    approximate: boolean;
    deletions: number;
    insertions: number;
};

/** Nothing is shown for a clean comparison, even when the checkout itself is known. */
export function visibleRigGitLineChanges(
    summary: RigGitSummary,
): VisibleRigGitLineChanges | null {
    if (summary.insertions === 0 && summary.deletions === 0) return null;
    return {
        approximate: !summary.countsExact,
        deletions: summary.deletions,
        insertions: summary.insertions,
    };
}
