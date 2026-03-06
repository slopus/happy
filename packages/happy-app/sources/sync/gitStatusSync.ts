/**
 * Git status synchronization module
 * Provides real-time git repository status tracking using remote bash commands
 */

import { InvalidateSync } from '@/utils/sync';
import { sessionBash } from './ops';
import { GitStatus, Session } from './storageTypes';
import { storage, getSession } from './storage';
import { parseStatusSummary, getStatusCounts, isDirty } from './git-parsers/parseStatus';
import { parseStatusSummaryV2, getStatusCountsV2, isDirtyV2, getCurrentBranchV2, getTrackingInfoV2 } from './git-parsers/parseStatusV2';
import { parseNumStat, mergeDiffSummaries } from './git-parsers/parseDiff';
import { projectManager, createProjectKey } from './projectManager';
import { getWorkspaceRepos, WorkspaceRepo } from '@/utils/workspaceRepos';
import { shellEscape } from '@/utils/shellEscape';
import { decideNotGitRefreshOutcome } from './gitStatusRefreshPolicy';
import { selectPreferredGitStatusSession } from './gitStatusSessionSelection';

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
    // Debounced retry timers for transient RPC/network failures
    private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Automatic retry attempts per project (for transient failures)
    private retryAttempts = new Map<string, number>();
    // Projects that have completed at least one successful git status fetch.
    private confirmedGitProjects = new Set<string>();
    // Consecutive non-git detections for each project.
    private consecutiveNotGitDetections = new Map<string, number>();
    // Maximum delay between retries (ms). Retries use exponential backoff and never stop.
    private readonly maxRetryDelay = 60_000;

    /**
     * Get project key string for a session
     */
    private getProjectKeyForSession(sessionId: string): string | null {
        const session = getSession(sessionId);
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
        const state = storage.getState();
        const sessionIds = this.projectToSessionIds.get(projectKey);
        if (!sessionIds || sessionIds.size === 0) {
            return null;
        }

        const candidates: Array<{ sessionId: string; session: Session }> = [];
        for (const sessionId of Array.from(sessionIds)) {
            const session = state.sessions[sessionId] ?? state.sharedSessions[sessionId];
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

            candidates.push({ sessionId, session });
        }

        return selectPreferredGitStatusSession(candidates, projectKey);
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

    private clearRetryTimer(projectKey: string): void {
        const timer = this.retryTimers.get(projectKey);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this.retryTimers.delete(projectKey);
    }

    private resetRetryAttempts(projectKey: string): void {
        this.retryAttempts.delete(projectKey);
    }

    private markGitFetchSucceeded(projectKey: string): void {
        this.confirmedGitProjects.add(projectKey);
        this.consecutiveNotGitDetections.delete(projectKey);
    }

    private handleNotGitRepository(
        projectKey: string,
        sessionId: string,
        metadata: { machineId?: string; path?: string }
    ): void {
        const decision = decideNotGitRefreshOutcome({
            hasConfirmedGitRepo: this.confirmedGitProjects.has(projectKey),
            consecutiveNotGitDetections: this.consecutiveNotGitDetections.get(projectKey) || 0,
        });
        this.consecutiveNotGitDetections.set(projectKey, decision.nextConsecutiveNotGitDetections);

        if (decision.action === 'preserve') {
            this.scheduleRetry(projectKey);
            return;
        }

        storage.getState().applyGitStatus(sessionId, null);
        if (metadata.machineId && metadata.path) {
            const targetProjectKey = createProjectKey(metadata.machineId, metadata.path);
            projectManager.updateProjectGitStatus(targetProjectKey, null);
        }
        this.clearRetryTimer(projectKey);
        this.resetRetryAttempts(projectKey);
    }

    private scheduleRetry(projectKey: string): void {
        if (this.retryTimers.has(projectKey)) {
            return;
        }
        const attempts = this.retryAttempts.get(projectKey) || 0;
        this.retryAttempts.set(projectKey, attempts + 1);

        // Exponential backoff: 2.5s, 5s, 10s, 20s, 40s, 60s, 60s, ...
        // Capped at maxRetryDelay — never gives up completely.
        const delayMs = Math.min(2500 * Math.pow(2, attempts), this.maxRetryDelay);

        const timer = setTimeout(() => {
            this.retryTimers.delete(projectKey);
            const sync = this.projectSyncMap.get(projectKey);
            if (sync) {
                sync.invalidate();
            }
        }, delayMs);
        this.retryTimers.set(projectKey, timer);
    }

    private getGitErrorText(result: {
        stdout?: string;
        stderr?: string;
        error?: string;
    }): string {
        return [result.error, result.stderr, result.stdout]
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join('\n')
            .toLowerCase();
    }

    private isNotGitRepositoryResult(result: {
        stdout?: string;
        stderr?: string;
        error?: string;
    }): boolean {
        const text = this.getGitErrorText(result);
        return text.includes('not a git repository') || text.includes('must be run in a work tree');
    }

    private isRpcNotAvailable(result: {
        stdout?: string;
        stderr?: string;
        error?: string;
    }): boolean {
        const text = this.getGitErrorText(result);
        return text.includes('rpc method not available');
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

        // Explicit invalidation starts a fresh retry cycle.
        this.resetRetryAttempts(projectKey);

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
                this.clearRetryTimer(projectKey);
                this.resetRetryAttempts(projectKey);
                this.consecutiveNotGitDetections.delete(projectKey);
                this.confirmedGitProjects.delete(projectKey);
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

                // Multi-repo workspace: aggregate git status across all repos
                const workspaceRepos = getWorkspaceRepos(metadata);
                if (workspaceRepos.length > 0) {
                    const aggregated = await this.fetchMultiRepoGitStatus(targetSessionId, workspaceRepos);
                    if (aggregated === 'retry') {
                        this.scheduleRetry(projectKey);
                        return;
                    }
                    storage.getState().applyGitStatus(targetSessionId, aggregated);
                    this.markGitFetchSucceeded(projectKey);
                    this.clearRetryTimer(projectKey);
                    this.resetRetryAttempts(projectKey);
                    if (metadata.machineId) {
                        const targetProjectKey = createProjectKey(metadata.machineId, metadata.path);
                        projectManager.updateProjectGitStatus(targetProjectKey, aggregated);
                    }
                    return;
                }

                // Single-repo path: check if we're in a git repository
                const gitCheckResult = await sessionBash(targetSessionId, {
                    command: 'git rev-parse --is-inside-work-tree',
                    cwd: metadata.path,
                    timeout: 5000
                });

                if (!gitCheckResult.success || gitCheckResult.exitCode !== 0) {
                    if (this.isNotGitRepositoryResult(gitCheckResult)) {
                        this.handleNotGitRepository(projectKey, targetSessionId, metadata);
                        return;
                    }

                    // Transient failure (RPC/network/session hiccup): keep previous status and retry.
                    if (!this.isRpcNotAvailable(gitCheckResult)) {
                        console.warn('Transient git check failure, keeping previous git status:', gitCheckResult.error || gitCheckResult.stderr);
                    }
                    this.scheduleRetry(projectKey);
                    return;
                }

                // Get git status in porcelain v2 format (includes branch info)
                // --untracked-files=all ensures we get individual files, not directories
                const statusResult = await sessionBash(targetSessionId, {
                    command: 'git status --porcelain=v2 --branch --show-stash --untracked-files=all',
                    cwd: metadata.path,
                    timeout: 10000
                });

                if (!statusResult.success || statusResult.exitCode !== 0) {
                    if (this.isNotGitRepositoryResult(statusResult)) {
                        this.handleNotGitRepository(projectKey, targetSessionId, metadata);
                        return;
                    }

                    if (!this.isRpcNotAvailable(statusResult)) {
                        console.warn('Transient git status failure, keeping previous git status:', statusResult.error || statusResult.stderr);
                    }
                    this.scheduleRetry(projectKey);
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

                if (!diffStatResult.success || diffStatResult.exitCode !== 0 ||
                    !stagedDiffStatResult.success || stagedDiffStatResult.exitCode !== 0) {
                    if (this.isNotGitRepositoryResult(diffStatResult) || this.isNotGitRepositoryResult(stagedDiffStatResult)) {
                        this.handleNotGitRepository(projectKey, targetSessionId, metadata);
                        return;
                    }

                    if (!this.isRpcNotAvailable(diffStatResult) && !this.isRpcNotAvailable(stagedDiffStatResult)) {
                        console.warn('Transient git diff-stat failure, keeping previous git status');
                    }
                    this.scheduleRetry(projectKey);
                    return;
                }

                // Parse the git status output with diff statistics
                const gitStatus = this.parseGitStatusV2(
                    statusResult.stdout,
                    diffStatResult.stdout,
                    stagedDiffStatResult.stdout
                );

                // Apply to storage (this also updates the project git status via the modified applyGitStatus)
                storage.getState().applyGitStatus(targetSessionId, gitStatus);
                this.markGitFetchSucceeded(projectKey);
                this.clearRetryTimer(projectKey);
                this.resetRetryAttempts(projectKey);

                // Additionally, update the project directly for efficiency
                if (metadata.machineId) {
                    const targetProjectKey = createProjectKey(metadata.machineId, metadata.path);
                    projectManager.updateProjectGitStatus(targetProjectKey, gitStatus);
                }
            });

        } catch (error) {
            console.error('Error fetching git status for project', projectKey, ':', error);
            // Transient unexpected error: keep previous state and retry.
            this.scheduleRetry(projectKey);
        }
    }

    /**
     * Fetch and aggregate git status across multiple workspace repos.
     * Returns aggregated GitStatus, or 'retry' on transient failure.
     */
    private async fetchMultiRepoGitStatus(
        sessionId: string,
        repos: WorkspaceRepo[],
    ): Promise<GitStatus | 'retry'> {
        const statuses: GitStatus[] = [];

        for (const repo of repos) {
            const repoPath = shellEscape(repo.path);
            const gitPrefix = `git -C ${repoPath}`;

            const gitCheckResult = await sessionBash(sessionId, {
                command: `${gitPrefix} rev-parse --is-inside-work-tree`,
                cwd: '/',
                timeout: 5000
            });
            if (!gitCheckResult.success || gitCheckResult.exitCode !== 0) {
                if (this.isNotGitRepositoryResult(gitCheckResult)) continue;
                return 'retry';
            }

            const [statusResult, diffResult, stagedDiffResult] = await Promise.all([
                sessionBash(sessionId, {
                    command: `${gitPrefix} status --porcelain=v2 --branch --show-stash --untracked-files=all`,
                    cwd: '/',
                    timeout: 10000,
                }),
                sessionBash(sessionId, {
                    command: `${gitPrefix} diff --numstat`,
                    cwd: '/',
                    timeout: 10000,
                }),
                sessionBash(sessionId, {
                    command: `${gitPrefix} diff --cached --numstat`,
                    cwd: '/',
                    timeout: 10000,
                }),
            ]);

            if (!statusResult.success || statusResult.exitCode !== 0) {
                if (this.isNotGitRepositoryResult(statusResult)) continue;
                return 'retry';
            }
            if (!diffResult.success || !stagedDiffResult.success) {
                if (this.isNotGitRepositoryResult(diffResult) || this.isNotGitRepositoryResult(stagedDiffResult)) continue;
                return 'retry';
            }

            statuses.push(this.parseGitStatusV2(
                statusResult.stdout,
                diffResult.stdout,
                stagedDiffResult.stdout,
            ));
        }

        if (statuses.length === 0) {
            return {
                branch: null, isDirty: false,
                modifiedCount: 0, untrackedCount: 0, stagedCount: 0,
                stagedLinesAdded: 0, stagedLinesRemoved: 0,
                unstagedLinesAdded: 0, unstagedLinesRemoved: 0,
                linesAdded: 0, linesRemoved: 0, linesChanged: 0,
                lastUpdatedAt: Date.now(),
                upstreamBranch: null,
            };
        }

        // Use first repo's branch info, aggregate counts
        const first = statuses[0];
        const aggregated: GitStatus = {
            branch: first.branch,
            upstreamBranch: first.upstreamBranch,
            aheadCount: first.aheadCount,
            behindCount: first.behindCount,
            stashCount: statuses.reduce((s, r) => s + (r.stashCount || 0), 0),
            isDirty: statuses.some(r => r.isDirty),
            modifiedCount: statuses.reduce((s, r) => s + r.modifiedCount, 0),
            untrackedCount: statuses.reduce((s, r) => s + r.untrackedCount, 0),
            stagedCount: statuses.reduce((s, r) => s + r.stagedCount, 0),
            stagedLinesAdded: statuses.reduce((s, r) => s + r.stagedLinesAdded, 0),
            stagedLinesRemoved: statuses.reduce((s, r) => s + r.stagedLinesRemoved, 0),
            unstagedLinesAdded: statuses.reduce((s, r) => s + r.unstagedLinesAdded, 0),
            unstagedLinesRemoved: statuses.reduce((s, r) => s + r.unstagedLinesRemoved, 0),
            linesAdded: statuses.reduce((s, r) => s + r.linesAdded, 0),
            linesRemoved: statuses.reduce((s, r) => s + r.linesRemoved, 0),
            linesChanged: statuses.reduce((s, r) => s + r.linesChanged, 0),
            lastUpdatedAt: Date.now(),
        };
        return aggregated;
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
