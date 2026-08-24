import type { RigGitSummary } from '@/sync/rig';

export type VisibleRigGitLineChanges = {
    approximate: boolean;
    deletions: number;
    insertions: number;
};

/** Matches happy-desktop's dense-row count formatting. */
export function compactCount(value: number): string {
    const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    if (count < 1_000) return String(count);
    if (count < 5_000) {
        const thousands = Math.round(count / 100) / 10;
        return `${String(thousands)}k`;
    }
    return `${String(Math.round(count / 1_000))}k`;
}

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
