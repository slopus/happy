export function isEmptyArray(v: unknown): v is [] {
  return Array.isArray(v) && v.length === 0;
}

export function equalOptionalStringArrays(a: unknown, b: unknown): boolean {
  // Treat `undefined` / `null` / `[]` as equivalent “empty”.
  if (a == null || isEmptyArray(a)) {
    return b == null || isEmptyArray(b);
  }
  if (b == null || isEmptyArray(b)) {
    return a == null || isEmptyArray(a);
  }
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

