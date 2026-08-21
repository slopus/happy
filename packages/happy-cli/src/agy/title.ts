/**
 * Session Title Extraction
 *
 * Extracts a concise, human-readable session title from the initial user prompt
 * so the Happy App sidebar displays a meaningful topic instead of "New Chat".
 */

export function extractSessionTitle(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') {
    return 'New Chat';
  }

  // Remove any system tags or wrappers
  const clean = prompt
    .replace(/<happy-system>[\s\S]*?<\/happy-system>/gi, '')
    .trim();

  if (!clean) {
    return 'New Chat';
  }

  // Find the first meaningful line
  const lines = clean.split('\n');
  let selected = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (
      line.length > 0 &&
      !line.startsWith('#') &&
      !line.startsWith('//') &&
      !line.startsWith('/*') &&
      !line.startsWith('<!--') &&
      !line.startsWith('```')
    ) {
      selected = line;
      break;
    }
  }

  if (!selected) {
    selected = clean.split('\n')[0]?.trim() || clean;
  }

  const maxLength = 50;
  if (selected.length <= maxLength) {
    return selected;
  }

  return selected.slice(0, maxLength).trimEnd() + '…';
}
