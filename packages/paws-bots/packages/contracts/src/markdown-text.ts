/**
 * Raw HTML that the renderer drops inside table cells still contributes text:
 * the web markdown renderer turns `<br>` into a space and `<img alt>` into its
 * alt text (preserveSkippedTableText in @rakazo/chat-ui). Quote validation must
 * reconstruct that same canonical text server-side, so the salvage semantics
 * live here as the single implementation both sides share.
 */
export function droppedTableHtmlText(html: string): string | null {
  if (/^<br[\s/>]/i.test(html)) return " ";
  const image = html.match(/^<img(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i);
  if (!image) return null;
  // Consume whole attributes so names and quoted values cannot impersonate alt.
  const attributes = image[1]?.matchAll(
    /\s([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  );
  for (const attribute of attributes ?? []) {
    if (attribute[1]?.toLowerCase() === "alt") {
      return decodeHtmlEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
  }
  return null;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return value.replace(
    /&(#(?:x[\da-f]+|\d+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, code: string) => {
      if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
      const point = Number.parseInt(
        code.slice(code[1]?.toLowerCase() === "x" ? 2 : 1),
        code[1]?.toLowerCase() === "x" ? 16 : 10,
      );
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    },
  );
}
