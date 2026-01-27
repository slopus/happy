/**
 * JSON stdout filtering helpers for ACP transports.
 *
 * ACP messages are sent as ndJSON where each line must be a JSON object (or an array for batches).
 * Many CLIs emit debug/progress output on stdout; we must drop those lines to avoid breaking ACP parsing.
 */

/**
 * Returns the original line when it is valid JSON and parses to an object/array; otherwise null.
 * Keeps the original `line` string (including its whitespace/newline) to preserve ndJSON framing.
 */
export function filterJsonObjectOrArrayLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Fast-path: must start like JSON object/array.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  // Validate it is parseable JSON and not a primitive.
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return line;
  } catch {
    return null;
  }
}

