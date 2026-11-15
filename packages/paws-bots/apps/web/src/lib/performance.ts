export function markOnce(name: string) {
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}

export function markAfterPaint(name: string) {
  if (performance.getEntriesByName(name).length > 0) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => markOnce(name));
  });
}
