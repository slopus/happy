/**
 * Normalizes a file path to match Claude Code's .claude/projects folder naming convention.
 *
 * Claude Code's actual algorithm (from @anthropic-ai/claude-code source):
 *   1. resolve(path) to get absolute path
 *   2. replace(/[^a-zA-Z0-9]/g, '-') — every non-alphanumeric char becomes a hyphen
 *   3. if result > 200 chars, truncate to 200 and append a hash suffix
 *
 * Since paths arriving via session.metadata.path are already absolute,
 * we skip the resolve step. We also skip the 200-char truncation since
 * real-world project paths rarely exceed that limit.
 *
 * @param path - The original absolute file path (e.g., "/Users/dev/my_project")
 * @returns The normalized path using Claude Code's naming convention (e.g., "-Users-dev-my-project")
 */
export function normalizePathForKey(path: string): string {
    if (!path) {
        return '';
    }

    return path.replace(/[^a-zA-Z0-9]/g, '-');
}
