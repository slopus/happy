/** Where a scroll was made, when the screen sent both coordinates; else nothing. */
export function scrollPoint(payload: Record<string, unknown>): { x?: number; y?: number } {
  if (payload.x === undefined || payload.y === undefined) return {};
  const x = Number(payload.x);
  const y = Number(payload.y);
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0
    ? { x: Math.round(x), y: Math.round(y) }
    : {};
}
