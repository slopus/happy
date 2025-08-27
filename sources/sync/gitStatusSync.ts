/**
 * Git status synchronization module
 * Provides real-time git repository status tracking using remote bash commands
 */

import { InvalidateSync } from '@/utils/sync';
import { sessionBash } from './ops';
import { GitStatus } from './storageTypes';
import { storage } from './storage';
import { parseStatusSummary, getStatusCounts, isDirty } from './git-parsers/parseStatus';
import { parseStatusSummaryV2, getStatusCountsV2, isDirtyV2, getCurrentBranchV2, getTrackingInfoV2 } from './git-parsers/parseStatusV2';
import { parseCurrentBranch } from './git-parsers/parseBranch';
import { parseNumStat, mergeDiffSummaries } from './git-parsers/parseDiff';

export class GitStatusSync {
    private syncMap = new Map<string, InvalidateSync>();

    /**
     * Get or create git status sync for a session
     */
    getSync(sessionId: string): InvalidateSync {
        let sync = this.syncMap.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchGitStatus(sessionId));
            this.syncMap.set(sessionId, sync);
        }
        return sync;
    }

    /**
     * Invalidate git status for a session (trigger refresh)
     */
    invalidate(sessionId: string): void {
        const sync = this.syncMap.get(sessionId);
        if (sync) {
            sync.invalidate();
        }
    }

    /**
     * Stop git status sync for a session
     */
    stop(sessionId: string): void {
        const sync = this.syncMap.get(sessionId);
        if (sync) {
            sync.stop();
            this.syncMap.delete(sessionId);
        }
    }

    /**
     * Fetch git status for a session using remote bash command
     */
    private async fetchGitStatus(sessionId: string): Promise<void> {
        try {
            // Check if we have a session with valid metadata
            const session = storage.getState().sessions[sessionId];
            if (!session?.metadata?.path) {
                return;
            }

            // First check if we're in a git repository
            const gitCheckResult = await sessionBash(sessionId, {
                command: 'git rev-parse --is-inside-work-tree',
                cwd: session.metadata.path,
                timeout: 5000
            });

            if (!gitCheckResult.success || gitCheckResult.exitCode !== 0) {
                // Not a git repository, clear any existing status
                storage.getState().applyGitStatus(sessionId, null);
                return;
            }

            // Get git status in porcelain v2 format (includes branch info)
            const statusResult = await sessionBash(sessionId, {
                command: 'git status --porcelain=v2 --branch --show-stash',
                cwd: session.metadata.path,
                timeout: 10000
            });

            if (!statusResult.success) {
                console.error('Failed to get git status:', statusResult.error);
                return;
            }

            // Get git diff statistics for unstaged changes
            const diffStatResult = await sessionBash(sessionId, {
                command: 'git diff --numstat',
                cwd: session.metadata.path,
                timeout: 10000
            });

            // Get git diff statistics for staged changes
            const stagedDiffStatResult = await sessionBash(sessionId, {
                command: 'git diff --cached --numstat',
                cwd: session.metadata.path,
                timeout: 10000
            });

            // Parse the git status output with diff statistics
            const gitStatus = this.parseGitStatusV2(
                statusResult.stdout,
                diffStatResult.success ? diffStatResult.stdout : '',
                stagedDiffStatResult.success ? stagedDiffStatResult.stdout : ''
            );

            // Apply to storage
            storage.getState().applyGitStatus(sessionId, gitStatus);

        } catch (error) {
            console.error('Error fetching git status for session', sessionId, ':', error);
            // Don't apply error state, just skip this update
        }
    }

    /**
     * Parse git status porcelain v2 output into structured data
     */
    private parseGitStatusV2(
        porcelainV2Output: string,
        diffStatOutput: string = '',
        stagedDiffStatOutput: string = ''
    ): GitStatus {
        // Parse status using v2 parser
        const statusSummary = parseStatusSummaryV2(porcelainV2Output);
        const counts = getStatusCountsV2(statusSummary);
        const repoIsDirty = isDirtyV2(statusSummary);
        const branchName = getCurrentBranchV2(statusSummary);
        const trackingInfo = getTrackingInfoV2(statusSummary);

        // Parse diff statistics
        const unstagedDiff = parseNumStat(diffStatOutput);
        const stagedDiff = parseNumStat(stagedDiffStatOutput);
        const { stagedAdded, stagedRemoved, unstagedAdded, unstagedRemoved } = mergeDiffSummaries(stagedDiff, unstagedDiff);
        
        // Calculate totals
        const linesAdded = stagedAdded + unstagedAdded;
        const linesRemoved = stagedRemoved + unstagedRemoved;
        const linesChanged = linesAdded + linesRemoved;

        return {
            branch: branchName,
            isDirty: repoIsDirty,
            modifiedCount: counts.modified,
            untrackedCount: counts.untracked,
            stagedCount: counts.staged,
            stagedLinesAdded: stagedAdded,
            stagedLinesRemoved: stagedRemoved,
            unstagedLinesAdded: unstagedAdded,
            unstagedLinesRemoved: unstagedRemoved,
            linesAdded,
            linesRemoved,
            linesChanged,
            lastUpdatedAt: Date.now(),
            // V2-specific fields
            upstreamBranch: statusSummary.branch.upstream || null,
            aheadCount: trackingInfo?.ahead,
            behindCount: trackingInfo?.behind,
            stashCount: statusSummary.stashCount
        };
    }

    /**
     * Parse git status porcelain output into structured data using simple-git parsers
     * (Legacy v1 fallback method - kept for compatibility)
     */
    private parseGitStatus(
        branchName: string | null, 
        porcelainOutput: string,
        diffStatOutput: string = '',
        stagedDiffStatOutput: string = ''
    ): GitStatus {
        // Parse status using simple-git parser
        const statusSummary = parseStatusSummary(porcelainOutput);
        const counts = getStatusCounts(statusSummary);
        const repoIsDirty = isDirty(statusSummary);

        // Parse diff statistics
        const unstagedDiff = parseNumStat(diffStatOutput);
        const stagedDiff = parseNumStat(stagedDiffStatOutput);
        const { stagedAdded, stagedRemoved, unstagedAdded, unstagedRemoved } = mergeDiffSummaries(stagedDiff, unstagedDiff);
        
        // Calculate totals
        const linesAdded = stagedAdded + unstagedAdded;
        const linesRemoved = stagedRemoved + unstagedRemoved;
        const linesChanged = linesAdded + linesRemoved;

        return {
            branch: branchName || null,
            isDirty: repoIsDirty,
            modifiedCount: counts.modified,
            untrackedCount: counts.untracked,
            stagedCount: counts.staged,
            stagedLinesAdded: stagedAdded,
            stagedLinesRemoved: stagedRemoved,
            unstagedLinesAdded: unstagedAdded,
            unstagedLinesRemoved: unstagedRemoved,
            linesAdded,
            linesRemoved,
            linesChanged,
            lastUpdatedAt: Date.now()
        };
    }

}

// Global singleton instance
export const gitStatusSync = new GitStatusSync();