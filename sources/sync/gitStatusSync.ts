/**
 * Git status synchronization module
 * Provides real-time git repository status tracking using remote bash commands
 */

import { InvalidateSync } from '@/utils/sync';
import { sessionBash } from './ops';
import { GitStatus } from './storageTypes';
import { storage } from './storage';

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

            // Get current branch name
            const branchResult = await sessionBash(sessionId, {
                command: 'git branch --show-current',
                cwd: session.metadata.path,
                timeout: 5000
            });

            // Get git status in porcelain format
            const statusResult = await sessionBash(sessionId, {
                command: 'git status --porcelain',
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
            const gitStatus = this.parseGitStatus(
                branchResult.success ? branchResult.stdout.trim() : null,
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
     * Parse git status porcelain output into structured data
     */
    private parseGitStatus(
        branchName: string | null, 
        porcelainOutput: string,
        diffStatOutput: string = '',
        stagedDiffStatOutput: string = ''
    ): GitStatus {
        const lines = porcelainOutput.trim().split('\n').filter(line => line.length > 0);
        
        let modifiedCount = 0;
        let untrackedCount = 0;
        let stagedCount = 0;

        for (const line of lines) {
            if (line.length < 2) continue;
            
            const indexStatus = line[0];
            const workingStatus = line[1];

            // Check for staged changes (index status)
            if (indexStatus !== ' ' && indexStatus !== '?') {
                stagedCount++;
            }

            // Check for working directory changes
            if (workingStatus === 'M' || workingStatus === 'D') {
                modifiedCount++;
            } else if (indexStatus === '?' && workingStatus === '?') {
                untrackedCount++;
            }
        }

        const isDirty = modifiedCount > 0 || untrackedCount > 0 || stagedCount > 0;

        // Parse diff statistics for line changes (separately for staged vs unstaged)
        const { stagedAdded, stagedRemoved, unstagedAdded, unstagedRemoved } = this.parseDiffStatsSeparately(diffStatOutput, stagedDiffStatOutput);
        
        // Calculate totals
        const linesAdded = stagedAdded + unstagedAdded;
        const linesRemoved = stagedRemoved + unstagedRemoved;
        const linesChanged = linesAdded + linesRemoved;

        return {
            branch: branchName || null,
            isDirty,
            modifiedCount,
            untrackedCount,
            stagedCount,
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

    /**
     * Parse git diff --numstat output to extract line addition/deletion statistics separately for staged vs unstaged
     * Format: <added>\t<removed>\t<filename>
     */
    private parseDiffStatsSeparately(diffStatOutput: string, stagedDiffStatOutput: string): { 
        stagedAdded: number; 
        stagedRemoved: number; 
        unstagedAdded: number; 
        unstagedRemoved: number; 
    } {
        let unstagedAdded = 0;
        let unstagedRemoved = 0;
        let stagedAdded = 0;
        let stagedRemoved = 0;

        // Parse unstaged changes
        const unstagedLines = diffStatOutput.trim().split('\n').filter(line => line.length > 0);
        for (const line of unstagedLines) {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const added = parseInt(parts[0], 10);
                const removed = parseInt(parts[1], 10);
                
                // Handle binary files (git shows '-' for binary files)
                if (!isNaN(added)) unstagedAdded += added;
                if (!isNaN(removed)) unstagedRemoved += removed;
            }
        }

        // Parse staged changes
        const stagedLines = stagedDiffStatOutput.trim().split('\n').filter(line => line.length > 0);
        for (const line of stagedLines) {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const added = parseInt(parts[0], 10);
                const removed = parseInt(parts[1], 10);
                
                // Handle binary files (git shows '-' for binary files)
                if (!isNaN(added)) stagedAdded += added;
                if (!isNaN(removed)) stagedRemoved += removed;
            }
        }

        return {
            stagedAdded,
            stagedRemoved,
            unstagedAdded,
            unstagedRemoved
        };
    }
}

// Global singleton instance
export const gitStatusSync = new GitStatusSync();