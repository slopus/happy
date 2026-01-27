import type { ToolPattern } from '../TransportHandler';

export type ToolPatternWithInputFields = ToolPattern & Readonly<{
  /**
   * Fields in input that indicate this tool (heuristic).
   * Used when the agent reports toolName as "other"/unknown.
   */
  inputFields?: readonly string[];
  /**
   * When true, this tool is the default when input is empty and the agent reports toolName as "other".
   * (Some providers omit inputs for tools like change_title.)
   */
  emptyInputDefault?: boolean;
}>;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmptyToolInput(input: Record<string, unknown> | undefined | null): boolean {
  if (!input) return true;
  if (Array.isArray(input)) return input.length === 0;
  return Object.keys(input).length === 0;
}

export function findToolNameFromId(
  toolCallId: string,
  patterns: readonly ToolPatternWithInputFields[],
  opts?: Readonly<{ preferLongestMatch?: boolean }>,
): string | null {
  const lowerId = toolCallId.toLowerCase();
  const preferLongestMatch = opts?.preferLongestMatch === true;

  if (!preferLongestMatch) {
    for (const toolPattern of patterns) {
      for (const pattern of toolPattern.patterns) {
        if (lowerId.includes(pattern.toLowerCase())) {
          return toolPattern.name;
        }
      }
    }
    return null;
  }

  // Prefer the most-specific match (longest substring). This avoids fragile ordering when IDs contain
  // multiple tool substrings (e.g. "write_todos-..." contains "write").
  let bestName: string | null = null;
  let bestLen = 0;

  for (const toolPattern of patterns) {
    for (const pattern of toolPattern.patterns) {
      const needle = pattern.toLowerCase();
      if (!needle) continue;
      if (!lowerId.includes(needle)) continue;
      if (needle.length > bestLen) {
        bestLen = needle.length;
        bestName = toolPattern.name;
      }
    }
  }

  return bestName;
}

export function findToolNameFromInputFields(
  input: Record<string, unknown>,
  patterns: readonly ToolPatternWithInputFields[],
): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const inputKeys = new Set(Object.keys(input).map(normalizeKey));
  if (inputKeys.size === 0) return null;

  for (const toolPattern of patterns) {
    const fields = toolPattern.inputFields;
    if (!fields || fields.length === 0) continue;
    if (fields.some((field) => inputKeys.has(normalizeKey(field)))) {
      return toolPattern.name;
    }
  }

  return null;
}

export function findEmptyInputDefaultToolName(
  patterns: readonly ToolPatternWithInputFields[],
): string | null {
  const found = patterns.find((p) => p.emptyInputDefault === true);
  return found?.name ?? null;
}

