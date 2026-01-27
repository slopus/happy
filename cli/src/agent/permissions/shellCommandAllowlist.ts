type ShellSplitResult =
  | { ok: true; segments: string[] }
  | { ok: false };

function matchesPrefixTokenBoundary(command: string, prefix: string): boolean {
  if (!command || !prefix) return false;
  if (!command.startsWith(prefix)) return false;
  if (command.length === prefix.length) return true;
  if (prefix.endsWith(' ')) return true;
  return command[prefix.length] === ' ';
}

/**
 * Strip a simple leading env-prelude like `FOO=bar BAR=baz ...` from a shell command.
 *
 * This intentionally does NOT try to implement full shell parsing. It's a UX-oriented helper
 * to reduce duplicate approvals for common env-var prefixes.
 *
 * Note: quoted assignment values (e.g. `FOO="bar baz" cmd`) are not supported and may be stripped
 * incorrectly. This is acceptable for this UX-oriented best-effort helper.
 */
export function stripSimpleEnvPrelude(command: string): string {
  const parts = command.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
    i++;
  }
  return parts.slice(i).join(' ');
}

/**
 * Split a shell command into top-level segments by control operators (`&&`, `||`, `|`, `;`, `&`, newlines).
 *
 * This is a conservative parser:
 * - It respects single/double quotes and backslash escapes.
 * - If we detect command substitution/backticks (`$(` or `` ` ``), we fail-closed (ok: false).
 * - If quotes are unbalanced, we fail-closed (ok: false).
 */
export function splitShellCommandTopLevel(command: string): ShellSplitResult {
  const src = command.trim();
  if (!src) return { ok: true, segments: [] };

  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const segments: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }

    if (!inDouble && ch === '\'') {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      // Fail-closed on command substitution / backticks: too hard to reason safely.
      if (ch === '`') return { ok: false };
      if (ch === '$' && src[i + 1] === '(') return { ok: false };

      // Control operators.
      if (ch === '\n' || ch === ';') {
        flush();
        continue;
      }

      if (ch === '&') {
        if (src[i + 1] === '&') i++; // consume second &
        flush();
        continue;
      }

      if (ch === '|') {
        if (src[i + 1] === '|') i++; // consume second |
        flush();
        continue;
      }
    }

    current += ch;
  }

  if (escaped || inSingle || inDouble) return { ok: false };
  flush();
  return { ok: true, segments };
}

type ShellAllowPattern =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string };

function isSegmentAllowed(segment: string, patterns: ShellAllowPattern[]): boolean {
  const raw = segment.trim();
  if (!raw) return false;

  for (const p of patterns) {
    if (p.kind === 'exact') {
      if (raw === p.value) return true;
    }
  }

  const effective = stripSimpleEnvPrelude(raw);
  const firstWord = effective.split(/\s+/).filter(Boolean)[0] ?? '';

  for (const p of patterns) {
    if (p.kind !== 'prefix') continue;
    const normalizedPrefix = stripSimpleEnvPrelude(p.value).trim();
    if (!normalizedPrefix) continue;

    // Command-name pattern: `git:*` should match `git ...` but not `github ...`.
    if (!/\s/.test(normalizedPrefix)) {
      if (firstWord === normalizedPrefix) return true;
      continue;
    }

    if (matchesPrefixTokenBoundary(effective, normalizedPrefix)) return true;
  }

  return false;
}

/**
 * Check whether a shell command is allowed by a set of explicit allow patterns.
 *
 * If the command contains control operators, we only allow it when *every* top-level segment is allowed.
 * This prevents `git:*` from accidentally allowing `git status && rm -rf ...`.
 */
export function isShellCommandAllowed(command: string, patterns: ShellAllowPattern[]): boolean {
  const raw = command.trim();
  if (!raw) return false;

  // Exact match on the full command always wins (including chained/piped commands).
  for (const p of patterns) {
    if (p.kind === 'exact' && p.value === raw) return true;
  }

  const split = splitShellCommandTopLevel(raw);
  if (!split.ok) return false;

  // If there are no operators, split.segments will be [raw] and this behaves like a normal match.
  for (const segment of split.segments) {
    if (!isSegmentAllowed(segment, patterns)) return false;
  }

  return split.segments.length > 0;
}
