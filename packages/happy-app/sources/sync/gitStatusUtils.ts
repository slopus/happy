import { GitStatus } from './storageTypes';

type GitStatusLineFields = Pick<
    GitStatus,
    'linesAdded' | 'linesRemoved' |
    'stagedLinesAdded' | 'stagedLinesRemoved' |
    'unstagedLinesAdded' | 'unstagedLinesRemoved'
>;
type GitStatusUntrackedFields = Pick<GitStatus, 'untrackedCount'>;

type GitStatusLoadFields = Pick<GitStatus, 'lastUpdatedAt'>;
type GitStatusMeaningfulFields = Pick<GitStatus, 'lastUpdatedAt' | 'isDirty'> & GitStatusLineFields;

export function getAddedLines(status: Partial<GitStatusLineFields> | null | undefined): number {
    if (!status) return 0;
    if (typeof status.linesAdded === 'number') {
        return status.linesAdded;
    }
    return (status.stagedLinesAdded || 0) + (status.unstagedLinesAdded || 0);
}

export function getRemovedLines(status: Partial<GitStatusLineFields> | null | undefined): number {
    if (!status) return 0;
    if (typeof status.linesRemoved === 'number') {
        return status.linesRemoved;
    }
    return (status.stagedLinesRemoved || 0) + (status.unstagedLinesRemoved || 0);
}

export function hasLineChanges(status: Partial<GitStatusLineFields> | null | undefined): boolean {
    return getAddedLines(status) > 0 || getRemovedLines(status) > 0;
}

export function getUntrackedCount(status: Partial<GitStatusUntrackedFields> | null | undefined): number {
    if (!status || typeof status.untrackedCount !== 'number') {
        return 0;
    }
    return status.untrackedCount;
}

export function hasLoadedGitStatus(status: Partial<GitStatusLoadFields> | null | undefined): boolean {
    if (!status || typeof status.lastUpdatedAt !== 'number') {
        return false;
    }
    return status.lastUpdatedAt > 0;
}

export function hasMeaningfulLineChanges(status: Partial<GitStatusMeaningfulFields> | null | undefined): boolean {
    if (!status) return false;
    if (!hasLoadedGitStatus(status)) return false;
    if (!status.isDirty) return false;
    return hasLineChanges(status);
}
