const GEMINI_TEXT_KEYS = new Set([
  'text',
  'content',
  'output',
  'message',
  'response',
  'result',
  'answer',
  'final_text',
]);

const GEMINI_META_KEYS = new Set([
  'session_id',
  'sessionId',
  'id',
  'usage',
  'metadata',
  'model',
  'role',
  'timestamp',
]);

const ANSI_ESCAPE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, '');
}

export function extractCodexSessionId(output: string): string | null {
  const cleaned = stripAnsi(output);
  const match = cleaned.match(/session id:\s*([^\s]+)/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim().replace(/^['"`(\[]+|[)\]"'`,.;:]+$/g, '');
  if (!/^[0-9a-zA-Z-]{8,}$/.test(token)) {
    return null;
  }
  return token;
}

export function extractGeminiSessionId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  // Try full JSON parse first (pretty-printed output)
  try {
    const parsed = JSON.parse(trimmed) as { session_id?: unknown };
    if (typeof parsed.session_id === 'string') {
      const sessionId = parsed.session_id.trim();
      if (sessionId.length > 0) {
        return sessionId;
      }
    }
  } catch (_error) {
    // not a single JSON document, try line-based
  }

  // Fallback: scan individual lines
  for (const line of stdout.split(/\r?\n/)) {
    const result = extractGeminiSessionIdFromJsonLine(line);
    if (result) {
      return result;
    }
  }

  return null;
}

export function extractGeminiSessionIdFromJsonLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { session_id?: unknown };
    if (typeof parsed.session_id === 'string') {
      const sessionId = parsed.session_id.trim();
      return sessionId.length > 0 ? sessionId : null;
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function collectGeminiTextCandidates(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectGeminiTextCandidates(item, out);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (GEMINI_META_KEYS.has(key)) {
      continue;
    }

    if (GEMINI_TEXT_KEYS.has(key)) {
      collectGeminiTextCandidates(child, out);
      continue;
    }

    if (key === 'parts' && Array.isArray(child)) {
      collectGeminiTextCandidates(child, out);
      continue;
    }

    // Traverse unknown keys as fallback for future JSON format changes
    collectGeminiTextCandidates(child, out);
  }
}

export function normalizeGeminiOutputText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return '';
  }

  const candidates: string[] = [];
  let sawJson = false;

  try {
    const parsed = JSON.parse(trimmed);
    sawJson = true;
    collectGeminiTextCandidates(parsed, candidates);
  } catch (_error) {
    // not a single JSON document, try line-based json output next
  }

  if (!sawJson) {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      try {
        const parsed = JSON.parse(trimmedLine);
        sawJson = true;
        collectGeminiTextCandidates(parsed, candidates);
      } catch (_error) {
        // ignore non-json line
      }
    }
  }

  if (!sawJson) {
    return trimmed;
  }

  const unique = [...new Set(candidates)];
  return unique.join('\n').trim();
}
