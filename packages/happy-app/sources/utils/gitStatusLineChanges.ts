import { GitStatus } from '@/sync/storageTypes';

export type GitLineChanges = {
    insertions: number;
    deletions: number;
};

/**
 * Line counts to show for a working copy.
 *
 * Everything the agent has done since the last commit counts, staged or not:
 * showing unstaged lines alone made the badge collapse to nothing the moment
 * an agent ran `git add`, even though the branch was just as dirty.
 */
export function getGitStatusLineChanges(status: GitStatus | null | undefined): GitLineChanges {
    if (!status) {
        return { insertions: 0, deletions: 0 };
    }
    return {
        insertions: status.linesAdded ?? 0,
        deletions: status.linesRemoved ?? 0,
    };
}

export function hasGitStatusLineChanges(status: GitStatus | null | undefined): boolean {
    const { insertions, deletions } = getGitStatusLineChanges(status);
    return insertions > 0 || deletions > 0;
}
