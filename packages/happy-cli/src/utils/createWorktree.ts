/**
 * Git worktree creation for new isolated Happy sessions.
 *
 * Mirrors the mobile app's convention (`<repo>/.dev/worktree/<name>`, see
 * packages/happy-app/sources/utils/worktree.ts WORKTREE_PATH_MARKER) so that
 * the app's worktree detection and cleanup recognise sessions opened from the
 * CLI's `open_session` MCP tool. The CLI runs on the same machine as the repo,
 * so it shells out to git directly rather than going through the app's
 * machineBash RPC.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@/ui/logger';

const execFileAsync = promisify(execFile);

/** Must match packages/happy-app/sources/utils/worktree.ts WORKTREE_DIR. */
const WORKTREE_DIR = '.dev/worktree';

const ADJECTIVES = [
    'amber', 'brave', 'calm', 'clever', 'cosmic', 'crimson', 'eager', 'gentle',
    'golden', 'jolly', 'lucid', 'mellow', 'nimble', 'quiet', 'rapid', 'sharp',
    'silent', 'smooth', 'solar', 'swift', 'teal', 'vivid', 'witty', 'zesty',
];
const NOUNS = [
    'archer', 'badger', 'canyon', 'cedar', 'comet', 'delta', 'ember', 'falcon',
    'forest', 'harbor', 'island', 'lagoon', 'meadow', 'nebula', 'ocean', 'orbit',
    'pixel', 'quartz', 'ridge', 'river', 'summit', 'thicket', 'valley', 'willow',
];

function randomWorktreeName(): string {
    const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    return `${adjective}-${noun}`;
}

export interface CreateWorktreeResult {
    /** Absolute path to the new worktree directory. */
    worktreePath: string;
    /** Name of the branch created for the worktree (same as the directory name). */
    branchName: string;
}

/**
 * Create a git worktree under `<repoRoot>/.dev/worktree/<adjective-noun>` with a
 * fresh branch of the same name. `repoDirectory` must be inside a git repo.
 * Retries with new random names on collision; throws if no name succeeds.
 */
export async function createWorktree(repoDirectory: string): Promise<CreateWorktreeResult> {
    const { stdout } = await execFileAsync('git', ['-C', repoDirectory, 'rev-parse', '--show-toplevel']);
    const repoRoot = stdout.trim();

    const maxAttempts = 5;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const name = randomWorktreeName();
        const relativePath = `${WORKTREE_DIR}/${name}`;
        try {
            await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '-b', name, relativePath]);
            return { worktreePath: `${repoRoot}/${relativePath}`, branchName: name };
        } catch (error) {
            lastError = error;
            logger.debug(`[createWorktree] attempt ${attempt}/${maxAttempts} failed for '${name}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`Failed to create worktree after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
