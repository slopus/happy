/**
 * Normalizes a file path to match Claude Code's .claude/projects folder naming convention.
 * This ensures consistent project key generation regardless of whether the path contains
 * special characters like underscores or dots.
 *
 * Claude Code converts paths like:
 * - /Users/dev/my_project -> -Users-dev-my-project
 * - /Users/dev/my.project -> -Users-dev-my-project
 * - /Users/dev/my-project -> -Users-dev-my-project
 *
 * @param path - The original file path (e.g., "/Users/dev/my_project")
 * @returns The normalized path using Claude Code's naming convention (e.g., "-Users-dev-my-project")
 *
 * @example
 * normalizePathForKey("/Users/dev/my_project") // "-Users-dev-my-project"
 * normalizePathForKey("/Users/dev/my.project") // "-Users-dev-my-project"
 * normalizePathForKey("~/Documents/test_dir") // "-Documents-test-dir"
 */
export function normalizePathForKey(path: string): string {
    if (!path) {
        return '';
    }

    // Remove home directory shortcut if present
    let result = path.replace(/^~/, '');

    // Replace all non-alphanumeric characters (except hyphen) with hyphens
    // This matches Claude Code's behavior where:
    // - Forward slashes (/) become hyphens
    // - Underscores (_) become hyphens
    // - Dots (.) become hyphens
    // - Other special characters become hyphens
    result = result.replace(/[^a-zA-Z0-9-]/g, '-');

    // Collapse multiple consecutive hyphens into one
    result = result.replace(/-+/g, '-');

    // Remove trailing hyphens (but keep leading hyphen as Claude Code does)
    result = result.replace(/-+$/g, '');

    return result;
}
