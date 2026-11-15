type Rect = { left: number; top: number; width: number; height: number; bottom: number };
/** Fixed portals inside the transformed host use its local coordinates. */
export function quotePlacement(selection: Rect, host: Omit<Rect, "bottom">, button: { width: number; height: number }) {
  const localTop = selection.top - host.top;
  const localBottom = selection.bottom - host.top;
  const above = localTop >= button.height + 8;
  const halfWidth = Math.min(button.width / 2, Math.max(0, host.width / 2 - 8));
  const left = Math.min(host.width - halfWidth - 8, Math.max(halfWidth + 8, selection.left - host.left + selection.width / 2));
  const minimumTop = above ? button.height + 8 : 8;
  const maximumTop = Math.max(minimumTop, host.height - (above ? 8 : button.height + 8));
  const top = Math.min(maximumTop, Math.max(minimumTop, above ? localTop - 8 : localBottom + 8));
  return { top, left, above };
}
