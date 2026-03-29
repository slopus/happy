/**
 * Normalizes a file path to match Claude Code's .claude/projects folder naming convention.
 *
 * Claude Code's actual algorithm (from @anthropic-ai/claude-code source):
 *   1. resolve(path) to get absolute path
 *   2. replace(/[^a-zA-Z0-9]/g, '-') -- every non-alphanumeric char becomes a hyphen
 *   3. if result > 200 chars, truncate to 200 and append a hash suffix
 */
export function normalizePathForKey(path: string): string {
    if (!path) {
        return '';
    }
    return path.replace(/[^a-zA-Z0-9]/g, '-');
}
