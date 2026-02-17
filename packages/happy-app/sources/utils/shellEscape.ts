/**
 * Shell-escape a value by wrapping it in single quotes.
 *
 * Any embedded single quotes are replaced with the sequence `'\''`
 * (end quote, escaped literal quote, restart quote) which is the
 * standard POSIX-safe approach.
 *
 * The returned string already includes the outer single quotes,
 * so callers should use it directly:
 *
 *   `git add -- ${shellEscape(path)}`
 */
export function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
