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
    // Trailing-edge debounce: coalesce rapid invalidations within a cooldown window
    // and fire once at the end of the window, so no invalidation is ever permanently lost.
    private lastFetchCompletedAt = new Map<string, number>();
    private readonly fetchCooldownMs = 3_000;
    private deferredInvalidations = new Map<string, ReturnType<typeof setTimeout>>();
    // Delimiter for combining multiple git commands into a single shell call.
    // Uses a hash-like string that cannot collide with git output or filenames.
    private static readonly GIT_SECTION_DELIMITER = '__GIT_SECT_d4e8f2a1b7c3__';
    // Combined timeout covers all 4 serial git commands (old: 5s + 10s + 10s + 10s).
    private static readonly COMBINED_GIT_TIMEOUT = 30_000;
    // Expected section count after splitting combined output by delimiter.
    // sections[0]=rev-parse, [1]=status, [2]=diff, [3]=cached-diff
    private static readonly EXPECTED_SECTION_COUNT = 4;

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

    private clearDeferredInvalidation(projectKey: string): void {
        const timer = this.deferredInvalidations.get(projectKey);
        if (timer) {
            clearTimeout(timer);
            this.deferredInvalidations.delete(projectKey);
        }
    }

    /**
     * Build a combined shell command that runs rev-parse, status, diff, and
     * cached-diff in one call, separated by the section delimiter.
     */
    private buildCombinedGitCommand(gitPrefix: string = 'git'): string {
        const delim = GitStatusSync.GIT_SECTION_DELIMITER;
        return [
            `${gitPrefix} rev-parse --is-inside-work-tree`,
            `echo '${delim}'`,
            `${gitPrefix} status --porcelain=v2 --branch --show-stash --untracked-files=all`,
            `echo '${delim}'`,
            `${gitPrefix} diff --numstat`,
            `echo '${delim}'`,
            `${gitPrefix} diff --cached --numstat`,
        ].join(' && ');
    }

    /**
     * Immediately trigger a git status fetch cycle for a project.
     * Shared by `invalidate()` and deferred invalidation callbacks.
     */
    private invalidateProject(projectKey: string, resetRetry: boolean = true): void {
        if (resetRetry) {
            this.resetRetryAttempts(projectKey);
        }

        let sync = this.projectSyncMap.get(projectKey);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchGitStatusForProject(projectKey));
            this.projectSyncMap.set(projectKey, sync);
        }
        sync.invalidate();
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

    /** Bundle retry timer + attempt counter cleanup (always called as a pair). */
    private clearRetryState(projectKey: string): void {
        this.clearRetryTimer(projectKey);
        this.resetRetryAttempts(projectKey);
    }

    private markGitFetchSucceeded(projectKey: string): void {
        this.confirmedGitProjects.add(projectKey);
        this.consecutiveNotGitDetections.delete(projectKey);
        this.lastFetchCompletedAt.set(projectKey, Date.now());
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
        this.clearRetryState(projectKey);
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
            // Retry without resetting the attempt counter (preserves backoff).
            this.invalidateProject(projectKey, false);
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

        // Trailing-edge debounce: if within cooldown, schedule a deferred
        // invalidation at the end of the window so nothing is permanently lost.
        const lastFetch = this.lastFetchCompletedAt.get(projectKey);
        if (lastFetch) {
            const elapsed = Date.now() - lastFetch;
            if (elapsed < this.fetchCooldownMs) {
                if (!this.deferredInvalidations.has(projectKey)) {
                    const remaining = this.fetchCooldownMs - elapsed;
                    const timer = setTimeout(() => {
                        this.deferredInvalidations.delete(projectKey);
                        this.invalidateProject(projectKey);
                    }, remaining);
                    this.deferredInvalidations.set(projectKey, timer);
                }
                return;
            }
        }

        // Clear any pending deferred invalidation since we're proceeding now.
        this.clearDeferredInvalidation(projectKey);

        this.invalidateProject(projectKey);
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

            // Only tear down project-scoped state when no sessions remain.
            // deferredInvalidations is project-keyed, so clearing it while other
            // sessions are alive would silently drop a pending refresh they need.
            if (!hasOtherSessions) {
                this.clearRetryState(projectKey);
                this.clearDeferredInvalidation(projectKey);
                this.consecutiveNotGitDetections.delete(projectKey);
                this.confirmedGitProjects.delete(projectKey);
                this.lastFetchCompletedAt.delete(projectKey);
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
                    this.clearRetryState(projectKey);
                    if (metadata.machineId) {
                        const targetProjectKey = createProjectKey(metadata.machineId, metadata.path);
                        projectManager.updateProjectGitStatus(targetProjectKey, aggregated);
                    }
                    return;
                }

                // Single-repo path: run all git commands in a single shell call
                // to reduce RPC overhead (4 calls → 1 call).
                const combinedCommand = this.buildCombinedGitCommand();

                const result = await sessionBash(targetSessionId, {
                    command: combinedCommand,
                    cwd: metadata.path,
                    timeout: GitStatusSync.COMBINED_GIT_TIMEOUT
                });

                if (!result.success || result.exitCode !== 0) {
                    if (this.isNotGitRepositoryResult(result)) {
                        this.handleNotGitRepository(projectKey, targetSessionId, metadata);
                        return;
                    }
                    if (!this.isRpcNotAvailable(result)) {
                        console.warn('Transient git status failure, keeping previous status:', result.error || result.stderr);
                    }
                    this.scheduleRetry(projectKey);
                    return;
                }

                // Parse combined output: [rev-parse, status, diff, cached-diff]
                const sections = result.stdout.split(GitStatusSync.GIT_SECTION_DELIMITER);
                if (sections.length !== GitStatusSync.EXPECTED_SECTION_COUNT) {
                    console.warn('Unexpected git combined output format, retrying');
                    this.scheduleRetry(projectKey);
                    return;
                }

                const gitStatus = this.parseGitStatusV2(
                    sections[1].trim(),
                    sections[2].trim(),
                    sections[3].trim()
                );

                // Apply to storage (this also updates the project git status via the modified applyGitStatus)
                storage.getState().applyGitStatus(targetSessionId, gitStatus);
                this.markGitFetchSucceeded(projectKey);
                this.clearRetryState(projectKey);

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

        // Fire all per-repo combined commands in parallel (restores old Promise.all concurrency).
        const repoResults = await Promise.all(repos.map(repo => {
            const repoPath = shellEscape(repo.path);
            const gitPrefix = `git -C ${repoPath}`;
            return sessionBash(sessionId, {
                command: this.buildCombinedGitCommand(gitPrefix),
                cwd: '/',
                timeout: GitStatusSync.COMBINED_GIT_TIMEOUT,
            });
        }));

        for (const result of repoResults) {
            if (!result.success || result.exitCode !== 0) {
                if (this.isNotGitRepositoryResult(result)) continue;
                return 'retry';
            }

            const sections = result.stdout.split(GitStatusSync.GIT_SECTION_DELIMITER);
            if (sections.length !== GitStatusSync.EXPECTED_SECTION_COUNT) {
                // Exit code 0 but unexpected format — treat as transient failure.
                return 'retry';
            }

            statuses.push(this.parseGitStatusV2(
                sections[1].trim(),
                sections[2].trim(),
                sections[3].trim(),
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
