const MAX_WORKTREE_NAME_LENGTH = 64;

// Worktree names become both a branch name and one path segment. Keep the
// accepted grammar deliberately narrower than git-check-ref-format: a single
// portable segment is sufficient for this UI and is safe to pass to the
// machine shell without allowing options, traversal, or shell metacharacters.
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?=[A-Za-z0-9_-]))*$/;

export function normalizeWorktreeName(value: string): string | null {
    const name = value.trim();
    if (
        name.length === 0
        || name.length > MAX_WORKTREE_NAME_LENGTH
        || !WORKTREE_NAME_PATTERN.test(name)
    ) {
        return null;
    }
    return name;
}

export function appendWorktreeNameSuffix(name: string, suffix: string): string {
    return `${name.slice(0, MAX_WORKTREE_NAME_LENGTH - suffix.length)}${suffix}`;
}
