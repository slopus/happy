/**
 * Models occasionally pass structured JSON where a string is expected; String() would write
 * "[object Object]", so objects are serialized as readable JSON instead.
 */
export function textContentArg(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
