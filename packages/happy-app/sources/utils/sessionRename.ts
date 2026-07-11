/**
 * Decides what to do with the raw text a user entered in the rename prompt.
 *
 * Returns the trimmed title to apply, or `null` when the rename should be
 * skipped: the prompt was cancelled (`input === null`), the input was empty /
 * whitespace-only, or it is unchanged from the current title. Keeping this pure
 * lets the UI stay thin and makes the rename decision easy to unit test.
 */
export function resolveSessionRename(input: string | null, currentTitle: string): string | null {
    if (input === null) {
        return null; // prompt cancelled
    }
    const trimmed = input.trim();
    if (trimmed.length === 0 || trimmed === currentTitle.trim()) {
        return null; // empty or unchanged
    }
    return trimmed;
}
