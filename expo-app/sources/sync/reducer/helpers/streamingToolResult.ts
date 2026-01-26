export function coerceStreamingToolResultChunk(
  value: unknown
): { stdoutChunk?: string; stderrChunk?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const streamFlag = obj._stream === true;
  const stdoutChunk = typeof obj.stdoutChunk === 'string' ? obj.stdoutChunk : undefined;
  const stderrChunk = typeof obj.stderrChunk === 'string' ? obj.stderrChunk : undefined;
  if (!streamFlag && !stdoutChunk && !stderrChunk) return null;
  if (!stdoutChunk && !stderrChunk) return null;
  return { stdoutChunk, stderrChunk };
}

export function mergeStreamingChunkIntoResult(
  existing: unknown,
  chunk: { stdoutChunk?: string; stderrChunk?: string }
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (typeof chunk.stdoutChunk === 'string') {
    const prev = typeof base.stdout === 'string' ? base.stdout : '';
    base.stdout = prev + chunk.stdoutChunk;
  }
  if (typeof chunk.stderrChunk === 'string') {
    const prev = typeof base.stderr === 'string' ? base.stderr : '';
    base.stderr = prev + chunk.stderrChunk;
  }
  return base;
}

export function mergeExistingStdStreamsIntoFinalResultIfMissing(
  existing: unknown,
  next: unknown
): unknown {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return next;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next;

  const prev = existing as Record<string, unknown>;
  const out = { ...(next as Record<string, unknown>) };

  if (typeof out.stdout !== 'string' && typeof prev.stdout === 'string') out.stdout = prev.stdout;
  if (typeof out.stderr !== 'string' && typeof prev.stderr === 'string') out.stderr = prev.stderr;
  return out;
}

