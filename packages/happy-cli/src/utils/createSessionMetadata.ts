/**
 * Session Metadata Factory
 *
 * Creates session state and metadata objects for all backends (Claude, Codex, Gemini).
 * This follows DRY principles by providing a single implementation for all backends.
 *
 * @module createSessionMetadata
 */

import os from 'node:os';
import { resolve } from 'node:path';

import type { AgentState, Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { detectGitWorktree } from '@/utils/gitWorktree';
import packageJson from '../../package.json';

/**
 * Backend flavor identifier for session metadata.
 */
export type BackendFlavor = 'claude' | 'codex' | 'gemini';

/**
 * Options for creating session metadata.
 */
export interface CreateSessionMetadataOptions {
    /** Backend flavor (claude, codex, gemini) */
    flavor: BackendFlavor;
    /** Machine ID for server identification */
    machineId: string;
    /** How the session was started */
    startedBy?: 'daemon' | 'terminal';
}

/**
 * Result containing both state and metadata for session creation.
 */
export interface SessionMetadataResult {
    /** Agent state for session */
    state: AgentState;
    /** Session metadata */
    metadata: Metadata;
}

/**
 * Creates session state and metadata for backend agents.
 *
 * This utility consolidates the common session metadata creation logic used by
 * Codex and Gemini backends, ensuring consistency across all backend implementations.
 *
 * @param opts - Options specifying flavor, machineId, and startedBy
 * @returns Object containing state and metadata for session creation
 *
 * @example
 * ```typescript
 * const { state, metadata } = createSessionMetadata({
 *     flavor: 'gemini',
 *     machineId: settings.machineId,
 *     startedBy: opts.startedBy
 * });
 *
 * const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
 * ```
 */
/** Env vars from daemon take priority; otherwise detect via git */
function detectWorktreeMetadata(): Partial<Metadata> {
    // New: multi-repo workspace
    if (process.env.HAPPY_WORKSPACE_REPOS) {
        try {
            const repos = JSON.parse(process.env.HAPPY_WORKSPACE_REPOS);
            return {
                isWorktree: true,
                workspaceRepos: repos,
                workspacePath: process.env.HAPPY_WORKSPACE_PATH,
            };
        } catch {
            // Fall through to legacy detection
        }
    }
    // Legacy: single-repo worktree (env vars from daemon)
    if (process.env.HAPPY_WORKTREE_BASE_PATH) {
        return {
            isWorktree: true,
            worktreeBasePath: process.env.HAPPY_WORKTREE_BASE_PATH,
            worktreeBranchName: process.env.HAPPY_WORKTREE_BRANCH_NAME,
        };
    }
    // Terminal: git auto-detection
    const info = detectGitWorktree(process.cwd());
    if (info.isWorktree) {
        return {
            isWorktree: true,
            worktreeBasePath: info.worktreeBasePath,
            worktreeBranchName: info.worktreeBranchName,
        };
    }
    return {};
}

export function createSessionMetadata(opts: CreateSessionMetadataOptions): SessionMetadataResult {
    const state: AgentState = {
        controlledByUser: false,
    };

    const metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: opts.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.flavor,
        // Worktree metadata: env vars from daemon take priority, otherwise detect via git
        ...detectWorktreeMetadata(),
    };

    return { state, metadata };
}
