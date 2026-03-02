/**
 * Shared utility for stripping auth-related environment variables.
 *
 * Issue #120: When Happy CLI spawns or invokes Claude Code, inherited shell auth
 * vars (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) must be
 * removed from the environment unless explicitly configured. If left in place they
 * override Claude Code's native OAuth / Max-plan authentication, causing API-limit
 * errors for users who rely on Claude Max.
 *
 * This module is used by:
 *   - daemon/run.ts        – child process env for daemon-spawned sessions
 *   - claude/claudeLocal.ts – child process env for local terminal sessions
 *   - claude/claudeRemote.ts – process.env before SDK invocation for remote sessions
 */

import { logger } from '@/ui/logger';

/** Auth-related env vars that Claude Code uses to select its authentication method. */
export const AUTH_VARS_TO_STRIP = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export type AuthVar = typeof AUTH_VARS_TO_STRIP[number];

/**
 * Build a clean environment by copying `inheritedEnv` and omitting auth vars that
 * are NOT present in `explicitVars`.
 *
 * Used when building the `env` object for a spawned child process (daemon, local
 * launcher). Call site example:
 *
 * ```ts
 * const env = buildEnvWithStrippedAuthVars(process.env, opts.claudeEnvVars ?? {});
 * spawn(cmd, args, { env: { ...env, ...opts.claudeEnvVars } });
 * ```
 *
 * @param inheritedEnv  The environment to copy from (typically `process.env`).
 * @param explicitVars  Vars explicitly configured by the user/profile. Auth vars
 *                      present here are kept; others are stripped.
 * @returns A new record with auth vars stripped (or preserved when in explicitVars).
 */
export function buildEnvWithStrippedAuthVars(
    inheritedEnv: Record<string, string | undefined>,
    explicitVars: Record<string, string> = {}
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(inheritedEnv)) {
        if (value === undefined) continue;
        if ((AUTH_VARS_TO_STRIP as readonly string[]).includes(key) && !(key in explicitVars)) {
            logger.debug(`[stripAuthEnvVars] Stripping inherited ${key} from env (not set by configuration)`);
            continue;
        }
        result[key] = value;
    }
    return result;
}

/**
 * Delete auth vars directly from `process.env` when they are NOT present in
 * `explicitVars`.
 *
 * Used by claudeRemote.ts, which cannot build a separate env object because the
 * Claude Code SDK reads `process.env` directly at spawn time for `.cjs` launcher
 * executables (see sdk/query.ts:343 – `spawnEnv = isCommandOnly ? getCleanEnv() : process.env`).
 *
 * @param explicitVars  Vars explicitly configured by the user/profile. Auth vars
 *                      present here are left untouched; others are deleted.
 */
export function deleteAuthVarsFromProcessEnv(
    explicitVars: Record<string, string> = {}
): void {
    for (const key of AUTH_VARS_TO_STRIP) {
        if (!(key in explicitVars) && process.env[key] !== undefined) {
            logger.debug(`[stripAuthEnvVars] Deleting inherited ${key} from process.env (not set by configuration)`);
            delete process.env[key];
        }
    }
}
