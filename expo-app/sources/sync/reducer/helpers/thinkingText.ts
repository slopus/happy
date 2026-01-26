export function normalizeThinkingChunk(chunk: string): string {
  const match = chunk.match(/^\*\*[^*]+\*\*\n([\s\S]*)$/);
  const body = match ? match[1] : chunk;
  // Some ACP providers stream thinking as word-per-line deltas (often `"\n"`-terminated).
  // Preserve paragraph breaks, but collapse single newlines into spaces for readability.
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, (m) => (m.length >= 2 ? '\n\n' : ' '));
}

export function unwrapThinkingText(text: string): string {
  const match = text.match(/^\*Thinking\.\.\.\*\n\n\*([\s\S]*)\*$/);
  return match ? match[1] : text;
}

export function wrapThinkingText(body: string): string {
  return `*Thinking...*\n\n*${body}*`;
}

