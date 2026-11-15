const reported = new WeakSet<object>();

export function markReportedError(error: unknown): void {
  if (error !== null && typeof error === "object") reported.add(error);
}

/** A queue wrapper may add context around an exception already reported by its handler. */
export function wasReportedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error) && seen.size < 10) {
    if (reported.has(error)) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}
