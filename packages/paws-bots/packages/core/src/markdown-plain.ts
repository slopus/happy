const PAYLOAD_MARK = "\uE000";
/**
 * A preview collapses to one line. Cap the source so a huge reply cannot
 * stall formatting — Android walks replies one at a time on its poll loop.
 * Leading whitespace does not spend this budget; a pad must not hide the body.
 */
const MAX_PREVIEW_SOURCE = 4_096;

/**
 * Markdown source → a single plain line for previews and notifications.
 * `maxSource` caps how much source is read; a caller that converts content the
 * user explicitly asked for, one line at a time, can raise it.
 */
export function plainTextFromMarkdown(
  markdown: string,
  { maxSource = MAX_PREVIEW_SOURCE }: { maxSource?: number } = {},
): string {
  // Fixed one-char tokens: literal mark characters are stashed first so tokens
  // never collide, and token length stays constant regardless of input — an
  // adversarial reply cannot inflate the intermediate string. Payload count
  // is bounded by the input length, and each payload is a slice of it.
  const payloads: string[] = [PAYLOAD_MARK];
  const markToken = `${PAYLOAD_MARK}0${PAYLOAD_MARK}`;
  const payloadPattern = new RegExp(`${PAYLOAD_MARK}(\\d+)${PAYLOAD_MARK}`, "g");
  // Restored payload text is never rescanned — literal marks that come back
  // out of a payload cannot form phantom tokens. Payloads only ever contain
  // earlier tokens, so the recursion is bounded by the payload count.
  const restore = (text: string): string =>
    text.replace(payloadPattern, (_match, index: string) => restore(payloads[Number(index)] ?? ""));
  // A payload's text must never carry a raw mark: one could sit next to
  // digits and impersonate a token on restore (a payload could even refer to
  // itself and recurse forever). Marks are rewritten as payload-0 tokens.
  const stash = (payload: string): string => {
    payloads.push(payload.replaceAll(PAYLOAD_MARK, markToken));
    return `${PAYLOAD_MARK}${payloads.length - 1}${PAYLOAD_MARK}`;
  };

  const source = boundedPreviewSource(markdown, maxSource);
  let text = source.text.replaceAll(PAYLOAD_MARK, markToken);
  text = takeFencedCode(text, stash, source.truncated);
  text = takeInlineCode(text, stash);
  text = takeEscapes(text, stash);
  // Autolinks may contain stashed escapes; flatten only those literal payloads.
  text = takeLinks(text)
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g, (_match, url: string) =>
      stash(restore(url)),
    )
    .replace(/<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>/g, (_match, email: string) => stash(restore(email)));
  text = stripUnderscoreEmphasis(stripHtmlTags(text));
  // Table rows keep only their cells; a separator row is pure syntax.
  // flattenTableRows also strips heading/list/quote/break markers per line so
  // it can see them: a marked line interrupts the table instead of becoming a
  // phantom row, while its stripped text still previews. Runs before the
  // emphasis strips so "| **a** |" still reads "a".
  text = flattenTableRows(text)
    .replace(/(\*\*)(.*?)\1/g, "$2")
    .replace(/(\*)([^*\n]+)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1");
  return restore(text).replace(/\s+/g, " ").trim();
}

const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

/** Every GFM delimiter cell needs at least one hyphen: `| : |` is content. */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/** Heading, quote, list and break markers; the line's own text survives.
 *  Mirrors Android: headings allow ≤3 leading spaces, `>` needs no space. */
function stripLineMarker(line: string): string {
  const stripped = line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "");
  return /^\s*[-*_]{3,}\s*$/.test(stripped) ? "" : stripped;
}

/** Row text → "a, b"; edge pipes only produce empty ends, which drop out. */
function tableCells(line: string): string {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * One line per table row ("a, b"). A separator line opens a table only when
 * the line above it held a pipe — that header may omit the outer pipes, and
 * lines after the separator are data rows even without them, until the first
 * no-pipe line ends the table. Only the first separator is syntax; later
 * dash-only rows are data. Pipe-wrapped lines still flatten leniently outside
 * tables so sloppy single rows preview cleanly. Lines carrying a block
 * marker (heading, quote, list, break) can never be table rows — they end the
 * table — but a quoted stand-alone row like `> | a |` still flattens, while a
 * marked separator row stays syntax.
 */
function flattenTableRows(text: string): string {
  const out: string[] = [];
  let inTable = false;
  let prevHadPipe = false;
  let prevFlattened = false;
  for (const rawLine of text.split("\n")) {
    const line = stripLineMarker(rawLine);
    if (line !== rawLine) {
      inTable = false;
      prevHadPipe = false;
      prevFlattened = false;
      // A separator row stays syntax even behind a quote or list marker.
      if (!isTableSeparator(line)) {
        out.push(TABLE_ROW.test(line) ? tableCells(line) : line);
      }
      continue;
    }
    if (!line.includes("|")) {
      inTable = false;
      prevHadPipe = false;
      prevFlattened = false;
      out.push(line);
      continue;
    }
    if (inTable) {
      out.push(tableCells(line));
      prevHadPipe = true;
      prevFlattened = true;
      continue;
    }
    if (isTableSeparator(line)) {
      if (prevHadPipe) {
        inTable = true;
        // A header written without outer pipes was emitted raw; flatten it now.
        if (!prevFlattened) out[out.length - 1] = tableCells(out[out.length - 1] ?? "");
      }
      continue;
    }
    if (TABLE_ROW.test(line)) {
      out.push(tableCells(line));
      prevFlattened = true;
    } else {
      out.push(line);
      prevFlattened = false;
    }
    prevHadPipe = true;
  }
  return out.join("\n");
}

/** Pair delimiter runs once, without rescanning unmatched suffixes. */
function stripUnderscoreEmphasis(text: string): string {
  type Delimiter = { start: number; end: number; removed: number };
  const delimiters: Delimiter[] = [];
  const openers: Delimiter[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(/_+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (text.slice(previousEnd, start).includes("\n")) {
      openers.length = 0;
    }
    previousEnd = end;
    const delimiter = { start, end, removed: 0 };
    delimiters.push(delimiter);
    // Two UTF-16 units preserve astral letters when checking each adjacent code point.
    const before = text.slice(Math.max(0, start - 2), start);
    const after = text.slice(end, end + 2);
    const canClose = !/^[\p{L}\p{N}\p{M}]/u.test(after) && /\S$/u.test(before);
    let remaining = end - start;
    while (canClose && remaining > 0 && openers.length) {
      const opener = openers[openers.length - 1];
      if (!opener) break;
      const available = opener.end - opener.start - opener.removed;
      const paired = Math.min(available, remaining);
      opener.removed += paired;
      delimiter.removed += paired;
      remaining -= paired;
      if (paired === available) openers.pop();
    }
    if (remaining > 0 && !/[\p{L}\p{N}\p{M}]$/u.test(before) && /^\S/u.test(after)) {
      openers.push(delimiter);
    }
  }
  const parts: string[] = [];
  let from = 0;
  for (const delimiter of delimiters) {
    if (!delimiter.removed) continue;
    parts.push(text.slice(from, delimiter.start));
    parts.push("_".repeat(delimiter.end - delimiter.start - delimiter.removed));
    from = delimiter.end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** Strip Markdown first so truncation cannot land inside a marker. */
export function truncatedPlainText(markdown: string, maxChars: number): string {
  return truncatePlainText(plainTextFromMarkdown(markdown), maxChars);
}

/** Keep UTF-16 offsets while avoiding cuts inside a surrogate pair. */
export function textBoundary(text: string, offset: number): number {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? offset - 1
    : offset;
}

/** Return a shorter nonempty prefix length, or zero when none exists. */
export function shortenedTextLength(text: string): number {
  const half = textBoundary(text, Math.floor(text.length / 2));
  // When the first character is a surrogate pair, retain it if there is more text.
  return half || (text.length > 2 ? 2 : 0);
}

/** Shorten plain text without splitting a surrogate pair. */
export function truncatePlainText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, textBoundary(text, maxChars));
}

/** Matching `>` for a tag at `<`, ignoring `>` inside quoted attributes. */
function htmlTagClose(text: string, open: number): number {
  if (text.startsWith("<!--", open)) {
    const close = text.indexOf("-->", open + 4);
    return close === -1 ? text.length - 1 : close + 2;
  }
  let quote: '"' | "'" | undefined;
  let gtInOpenQuote = -1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        gtInOpenQuote = -1;
        continue;
      }
      if (ch === ">" && gtInOpenQuote === -1) gtInOpenQuote = i;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  if (gtInOpenQuote !== -1) return gtInOpenQuote;
  // Unclosed quote with no `>`: consume the rest so attribute text cannot leak.
  return quote && text.length > open + 1 ? text.length - 1 : -1;
}

// A tag opens with `!`, `?`, or a name of letters, digits and hyphens followed by
// whitespace, `/` or `>` and then attribute-like content; `a<b+1` and `y && z` are prose.
const HTML_TAG_START =
  /(?:[!?]|\/?[A-Za-z][A-Za-z0-9-]*(?:[/>]|\s+(?:[/>]|[A-Za-z_:@][^\s"'<>/=&]*(?:[\s=/>]|$))))/y;

function isHtmlTagStart(text: string, at: number): boolean {
  HTML_TAG_START.lastIndex = at + 1;
  return HTML_TAG_START.test(text);
}

function stripHtmlTags(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<" && isHtmlTagStart(text, i)) {
      const close = htmlTagClose(text, i);
      if (close !== -1) {
        out += " ";
        i = close + 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function takeEscapes(text: string, stash: (payload: string) => string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_match, ch: string) =>
    stash(ch),
  );
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Source window for a preview. Messages that already fit are returned whole
 * so a normal reply is unchanged. Past the cap, leading whitespace is skipped
 * first — otherwise a pad of spaces consumes the window and the body vanishes.
 */
function boundedPreviewSource(
  markdown: string,
  maxSource: number,
): { text: string; truncated: boolean } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (normalized.length <= maxSource) return { text: normalized, truncated: false };
  const body = normalized.trimStart();
  if (body.length <= maxSource) return { text: body, truncated: false };
  return { text: truncatePlainText(body, maxSource), truncated: true };
}

function takeFencedCode(
  text: string,
  stash: (payload: string) => string,
  truncated: boolean,
): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = line.match(OPEN_FENCE);
    const marker = open?.[1];
    if (!marker) {
      out.push(line);
      continue;
    }
    const fenceChar = marker[0];
    if (fenceChar === "`" && (open?.[2] ?? "").includes("`")) {
      out.push(line);
      continue;
    }
    const body: string[] = [];
    let closed = false;
    // Blank-info fence lines are the only closers. If this scan sees none,
    // no later opener can close either, so the tail is not scanned again.
    let sawCloser = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j]?.match(OPEN_FENCE);
      const closeMarker = close?.[1];
      if (closeMarker && (close?.[2] ?? "").trim() === "") {
        sawCloser = true;
        if (closeMarker[0] === fenceChar && closeMarker.length >= marker.length) {
          closed = true;
          break;
        }
      }
      body.push(lines[j] ?? "");
    }
    if (!closed) {
      // The cap removed the closing fence. Keep the body verbatim: the opener
      // stays out of the preview, and later passes cannot strip the code.
      if (truncated && j === lines.length) {
        out.push(stash(body.join("\n")));
        break;
      }
      out.push(line);
      if (!sawCloser) {
        for (let k = i + 1; k < lines.length; k++) out.push(lines[k] ?? "");
        break;
      }
      continue;
    }
    out.push(stash(body.join("\n")));
    i = j;
  }
  return out.join("\n");
}

function takeInlineCode(text: string, stash: (payload: string) => string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i];
      i += 1;
      continue;
    }
    let n = 0;
    while (text[i + n] === "`") n += 1;
    const close = findInlineCodeClose(text, i + n, n);
    if (close === -1) {
      out += text.slice(i, i + n);
      i += n;
      continue;
    }
    out += stash(text.slice(i + n, close));
    i = close + n;
  }
  return out;
}

function findInlineCodeClose(text: string, from: number, n: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "`") continue;
    let m = 0;
    while (text[i + m] === "`") m += 1;
    if (m === n) return i;
    i += m - 1;
  }
  return -1;
}

function takeLinks(text: string): string {
  const closeBracket = closerAt(text, "[", "]");
  const closeParen = closerAt(text, "(", ")");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const image = text.startsWith("![", i);
    if (image || text[i] === "[") {
      const open = image ? i + 1 : i;
      const labelEnd = closeBracket[open];
      if (labelEnd !== undefined && text[labelEnd + 1] === "(") {
        const destEnd = closeParen[labelEnd + 1];
        if (destEnd !== undefined) {
          out += text.slice(open + 1, labelEnd);
          i = destEnd + 1;
          continue;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function closerAt(text: string, open: string, close: string): Array<number | undefined> {
  const closeAt: Array<number | undefined> = Array.from({ length: text.length });
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === open) stack.push(i);
    else if (text[i] === close) {
      const start = stack.pop();
      if (start !== undefined) closeAt[start] = i;
    }
  }
  return closeAt;
}
