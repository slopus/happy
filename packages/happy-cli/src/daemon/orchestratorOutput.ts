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
