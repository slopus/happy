export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** `value.slice(0, end)` that backs off one unit when the cut would split a surrogate pair. */
export function sliceWellFormed(value: string, end: number): string {
  const before = value.charCodeAt(end - 1);
  const after = value.charCodeAt(end);
  const splits = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return value.slice(0, splits ? end - 1 : end);
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
  keep: "start" | "end" = "start",
): string {
  if (maxBytes <= 0) return "";
  if (keep === "end") {
    let start = value.length;
    let bytes = 0;
    while (start > 0) {
      let nextStart = start - 1;
      const code = value.charCodeAt(nextStart);
      const previous = value.charCodeAt(nextStart - 1);
      if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
        nextStart -= 1;
      }
      const characterBytes = byteLength(value.slice(nextStart, start));
      if (bytes + characterBytes > maxBytes) break;
      bytes += characterBytes;
      start = nextStart;
    }
    return value.slice(start);
  }
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}
