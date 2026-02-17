/**
 * Git status synchronization module
 * Provides real-time git repository status tracking using remote bash commands
 */

import { InvalidateSync } from '@/utils/sync';
import { sessionBash } from './ops';
import { GitStatus, Session } from './storageTypes';
import { storage } from './storage';
import { parseStatusSummary, getStatusCounts, isDirty } from './git-parsers/parseStatus';
import { parseStatusSummaryV2, getStatusCountsV2, isDirtyV2, getCurrentBranchV2, getTrackingInfoV2 } from './git-parsers/parseStatusV2';
import { parseNumStat, mergeDiffSummaries } from './git-parsers/parseDiff';
import { projectManager, createProjectKey } from './projectManager';

export class GitStatusSync {
    // Map project keys to sync instances
    private projectSyncMap = new Map<string, InvalidateSync>();
    // Map session IDs to project keys for cleanup
    private sessionToProjectKey = new Map<string, string>();
    // Reverse index for fast lookup of live session by project key
    private projectToSessionIds = new Map<string, Set<string>>();
    // Limit concurrent git status fetches to avoid shell request bursts
    private inFlightFetches = 0;
    private fetchWaiters: Array<() => void> = [];
    private readonly maxConcurrentFetches = 3;

    /**
     * Get project key string for a session
     */
    private getProjectKeyForSession(sessionId: string): string | null {
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.machineId || !session?.metadata?.path) {
            return null;
        }
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }

    private linkSessionToProject(sessionId: string, projectKey: string): void {
        const previousProjectKey = this.sessionToProjectKey.get(sessionId);
        if (previousProjectKey && previousProjectKey !== projectKey) {
            const previousSet = this.projectToSessionIds.get(previousProjectKey);
            if (previousSet) {
                previousSet.delete(sessionId);
                if (previousSet.size === 0) {
                    this.projectToSessionIds.delete(previousProjectKey);
                }
            }
        }

        this.sessionToProjectKey.set(sessionId, projectKey);
        let sessionIds = this.projectToSessionIds.get(projectKey);
        if (!sessionIds) {
            sessionIds = new Set<string>();
            this.projectToSessionIds.set(projectKey, sessionIds);
        }
        sessionIds.add(sessionId);
    }

    private unlinkSession(sessionId: string): string | null {
        const projectKey = this.sessionToProjectKey.get(sessionId);
        if (!projectKey) {
            return null;
        }

        this.sessionToProjectKey.delete(sessionId);
        const sessionIds = this.projectToSessionIds.get(projectKey);
        if (sessionIds) {
            sessionIds.delete(sessionId);
            if (sessionIds.size === 0) {
                this.projectToSessionIds.delete(projectKey);
            }
        }

        return projectKey;
    }

    private getLiveSessionForProject(projectKey: string): { sessionId: string; session: Session } | null {
        const sessions = storage.getState().sessions;
        const sessionIds = this.projectToSessionIds.get(projectKey);
        if (!sessionIds || sessionIds.size === 0) {
            return null;
        }

        for (const sessionId of Array.from(sessionIds)) {
            const session = sessions[sessionId];
            if (!session) {
                this.unlinkSession(sessionId);
                continue;
            }

            const currentProjectKey = this.getProjectKeyForSession(sessionId);
            if (!currentProjectKey) {
                this.unlinkSession(sessionId);
                continue;
            }

            if (currentProjectKey !== projectKey) {
                this.linkSessionToProject(sessionId, currentProjectKey);
                continue;
            }

            if (!session.metadata?.path) {
                this.unlinkSession(sessionId);
                continue;
            }

            return { sessionId, session };
        }

        return null;
    }

    private async withFetchSlot<T>(task: () => Promise<T>): Promise<T> {
        if (this.inFlightFetches >= this.maxConcurrentFetches) {
            await new Promise<void>((resolve) => {
                this.fetchWaiters.push(resolve);
            });
        }

        this.inFlightFetches++;
        try {
            return await task();
        } finally {
            this.inFlightFetches = Math.max(0, this.inFlightFetches - 1);
            const next = this.fetchWaiters.shift();
            if (next) {
                next();
            }
        }
    }

    /**
     * Get or create git status sync for a session (creates project-based sync)
     */
    getSync(sessionId: string): InvalidateSync {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) {
            // Return a no-op sync if no valid project
            return new InvalidateSync(async () => {});
        }

        this.linkSessionToProject(sessionId, projectKey);

        let sync = this.projectSyncMap.get(projectKey);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchGitStatusForProject(projectKey));
            this.projectSyncMap.set(projectKey, sync);
        }
        return sync;
    }

    /**
     * Invalidate git status for a session (triggers refresh for the entire project)
     */
    invalidate(sessionId: string): void {
        const currentProjectKey = this.getProjectKeyForSession(sessionId);
        if (currentProjectKey) {
            this.linkSessionToProject(sessionId, currentProjectKey);
        }

        const projectKey = currentProjectKey || this.sessionToProjectKey.get(sessionId);
        if (!projectKey) {
            return;
        }

        let sync = this.projectSyncMap.get(projectKey);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchGitStatusForProject(projectKey));
            this.projectSyncMap.set(projectKey, sync);
        }
        sync.invalidate();
    }

    /**
     * Invalidate git status for multiple sessions (deduped by project key)
     */
    invalidateForSessions(sessionIds: string[]): void {
        const seenProjectKeys = new Set<string>();
        for (const sessionId of sessionIds) {
            const projectKey = this.getProjectKeyForSession(sessionId);
            if (!projectKey || seenProjectKeys.has(projectKey)) {
                continue;
            }
            seenProjectKeys.add(projectKey);
            this.invalidate(sessionId);
        }
    }

    /**
     * Stop git status sync for a session
     */
    stop(sessionId: string): void {
        const projectKey = this.unlinkSession(sessionId);
        if (projectKey) {
            const remainingSessions = this.projectToSessionIds.get(projectKey);
            const hasOtherSessions = !!remainingSessions && remainingSessions.size > 0;
            
            // Only stop the project sync if no other sessions are using it
            if (!hasOtherSessions) {
                const sync = this.projectSyncMap.get(projectKey);
                if (sync) {
                    sync.stop();
                    this.projectSyncMap.delete(projectKey);
                }
            }
        }
    }

    /**
     * Clear git status for a session when it's deleted
     * Similar to stop() but also clears any stored git status
     */
    clearForSession(sessionId: string): void {
        // First stop any active syncs
        this.stop(sessionId);
        
        // Clear git status from storage
        storage.getState().applyGitStatus(sessionId, null);
    }

    /**
     * Fetch git status for a project using any session in that project
     */
    private async fetchGitStatusForProject(projectKey: string): Promise<void> {
        try {
            await this.withFetchSlot(async () => {
                const liveSession = this.getLiveSessionForProject(projectKey);
                if (!liveSession) {
                    return;
                }
                const { sessionId: targetSessionId, session: targetSession } = liveSession;
                const metadata = targetSession.metadata;
                if (!metadata?.path) {
                    this.unlinkSession(targetSessionId);
                    return;
                }

                // First check if we're in a git repository
                const gitCheckResult = await sessionBash(targetSessionId, {
                    command: 'git rev-parse --is-inside-work-tree',
                    cwd: metadata.path,
                    timeout: 5000
                });

                if (!gitCheckResult.success || gitCheckResult.exitCode !== 0) {
                    // Not a git repository, clear any existing status
                    storage.getState().applyGitStatus(targetSessionId, null);

                    // Also update the project git status
                    if (metadata.machineId) {
                        const targetProjectKey = createProjectKey(metadata.machineId, metadata.path);
                        projectManager.updateProjectGitStatus(targetProjectKey, null);
                    }
                    return;
                }

                // Get git status in porcelain v2 format (includes branch info)
                // --untracked-files=all ensures we get individual files, not directories
                const statusResult = await sessionBash(targetSessionId, {
                    command: 'git status --porcelain=v2 --branch --show-stash --untracked-files=all',
                    cwd: metadata.path,
                    timeout: 10000
                });

                if (!statusResult.success) {
                    console.error('Failed to get git status:', statusResult.error);
                    return;
                }

                // Get git diff statistics for unstaged changes
                const diffStatResult = await sessionBash(targetSessionId, {
                    command: 'git diff --numstat',
                    cwd: metadata.path,
                    timeout: 10000
                });

                // Get git diff statistics for staged changes
                const stagedDiffStatResult = await sessionBash(targetSessionId, {
                    command: 'git diff --cached --numstat',
                    cwd: metadata.path,
                    timeout: 10000
                });

                // Parse the git status output with diff statistics
                const gitStatus = this.parseGitStatusV2(
                    statusResult.stdout,
                    diffStatResult.success ? diffStatResult.stdout : '',
                    stagedDiffStatResult.success ? stagedDiffStatResult.stdout : ''
                );

                // Apply to storage (this also updates the project git status via the modified applyGitStatus)
                storage.getState().applyGitStatus(targetSessionId, gitStatus);

                // Additionally, update the project directly for efficiency
                if (metadata.machineId) {
                    const targetProjectKey = createProjectKey(metadata.machineId, metadata.path);
                    projectManager.updateProjectGitStatus(targetProjectKey, gitStatus);
                }
            });

        } catch (error) {
            console.error('Error fetching git status for project', projectKey, ':', error);
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
