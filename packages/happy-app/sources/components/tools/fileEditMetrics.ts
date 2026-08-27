import { getDiffStats, getPatchDiffStats } from '@/components/diff/calculateDiff';

export interface FileEditDiffSection {
    patch?: string;
    oldText?: string;
    newText?: string;
}

export interface FileEditDiffMetrics {
    additions: number;
    deletions: number;
    changedLines: number;
}

/** Edits above this many changed lines start collapsed to a preview. */
export const LARGE_EDIT_CHANGED_LINES = 40;

export function getFileEditDiffMetrics(sections: readonly FileEditDiffSection[]): FileEditDiffMetrics {
    let additions = 0;
    let deletions = 0;
    for (const section of sections) {
        const stats = section.patch !== undefined
            ? getPatchDiffStats(section.patch)
            : getDiffStats(section.oldText ?? '', section.newText ?? '');
        additions += stats.additions;
        deletions += stats.deletions;
    }
    return { additions, deletions, changedLines: additions + deletions };
}
