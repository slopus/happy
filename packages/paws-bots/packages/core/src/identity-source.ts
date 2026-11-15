// Runtime-only provenance survives object spreads but never appears in JSON.
// Only fields changed by an identity display projection receive an entry.
const sources = Symbol("identitySourceNames");
type Entry = { source: unknown; displayed: string };
type Named = Record<string, unknown> & { [sources]?: Record<string, Entry> };

export function identitySourceField(value: object, key: string): unknown {
  const row = value as Named;
  const entry = row[sources]?.[key];
  return entry && row[key] === entry.displayed ? entry.source : row[key];
}

export function preserveIdentitySource<T extends object>(
  source: object,
  displayed: T,
  keys = Object.keys(displayed),
): T {
  if (source === displayed) return displayed;
  const original = source as Named;
  const next = displayed as Named;
  const entries: Record<string, Entry> = {};
  for (const key of keys) {
    const value = next[key];
    const entry = original[sources]?.[key];
    if (entry && value === entry.displayed && original[key] === entry.displayed) {
      entries[key] = entry;
    } else if (
      Object.hasOwn(original, key) &&
      typeof value === "string" &&
      (typeof identitySourceField(source, key) === "string" ||
        identitySourceField(source, key) == null) &&
      value !== original[key]
    ) {
      entries[key] = { source: identitySourceField(source, key), displayed: value };
    }
  }
  if (Object.keys(entries).length) {
    Object.defineProperty(displayed, sources, {
      value: entries,
      enumerable: true,
      configurable: true,
    });
  }
  return displayed;
}

/** Recover source identity values before writing a client display model to a cache. */
export function identitySource<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const next = value.map(identitySource);
    return (next.every((item, index) => Object.is(item, value[index])) ? value : next) as T;
  }
  let result = value;
  for (const key of Object.keys(value)) {
    const original = (value as Named)[key];
    const next = identitySource(identitySourceField(value, key));
    if (Object.is(next, original)) continue;
    if (result === value) result = { ...value };
    (result as Named)[key] = next;
  }
  return result;
}
