/**
 * Effort levels for Claude sessions.
 *
 * One list for both places a level enters the CLI: the `--effort` flag and
 * `meta.effort` on messages from the app. Remote turns pass the level to the
 * Agent SDK, which hands it to Claude Code unchanged as `--effort`.
 */

/**
 * The values Claude Code takes for `--effort`. 'ultracode' is not an API
 * effort level: Claude Code runs it as xhigh with ultracode (dynamic-workflow
 * orchestration) turned on for the session.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

export type ClaudeEffort = typeof CLAUDE_EFFORT_LEVELS[number];

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
    return typeof value === 'string' && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}
