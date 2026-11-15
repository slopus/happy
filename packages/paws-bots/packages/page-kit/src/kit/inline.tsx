import type { MouseEvent, ReactNode } from "react";
import { Children, Fragment } from "react";

/** The frame cannot open windows itself; the host opens web links it is asked to. */
const OPEN_LINK_MESSAGE = "rakazo-page:open-link";

export function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function openViaHost(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  window.parent?.postMessage({ type: OPEN_LINK_MESSAGE, url: event.currentTarget.href }, "*");
}

export function Link({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className="rk-link" href={href} rel="noopener noreferrer" onClick={openViaHost}>
      {children ?? href}
    </a>
  );
}

const WORD = /[\p{L}\p{N}_]/u;
const URL_END = /[\s<>"]/;
/** Punctuation that ends a sentence rather than the link, trimmed by walking back from the end. */
const URL_TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "'"]);

// Keep paired closers, then trim with a backwards walk. Both scans stay linear;
// a `[...]+$` regex retries from every start in a long punctuation run.
function withoutTrailingPunctuation(raw: string): string {
  let parentheses = 0;
  let brackets = 0;
  let lastPairedCloser = -1;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === "(") parentheses++;
    else if (char === "[") brackets++;
    else if (char === ")" && parentheses > 0) {
      parentheses--;
      lastPairedCloser = index;
    } else if (char === "]" && brackets > 0) {
      brackets--;
      lastPairedCloser = index;
    }
  }
  let end = raw.length;
  while (end > lastPairedCloser + 1 && URL_TRAILING.has(raw[end - 1]!)) end--;
  return raw.slice(0, end);
}

/**
 * **strong**, *em* or _em_, `code` and bare http(s) or www. links in one pass over the text.
 * Each marker looks for its closer at most once, so the scan stays linear on any input.
 */
export function inlineMarkup(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = 0;
  const emit = (start: number, end: number, node: ReactNode) => {
    if (start > plain) out.push(text.slice(plain, start));
    out.push(<Fragment key={out.length}>{node}</Fragment>);
    plain = end;
  };
  const boundary = (index: number) => index < 0 || index >= text.length || !WORD.test(text[index]!);
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1 && !text.slice(index + 1, close).includes("\n")) {
        emit(index, close + 1, <code className="rk-code">{text.slice(index + 1, close)}</code>);
        index = close;
      }
    } else if (char === "_" && boundary(index - 1)) {
      const close = text.indexOf("_", index + 1);
      const inner = close > index + 1 ? text.slice(index + 1, close) : "";
      if (inner && !/^\s|\s$|\n/.test(inner) && boundary(close + 1)) {
        emit(index, close + 1, <em>{inlineMarkup(inner)}</em>);
        index = close;
      }
    } else if (char === "*" && boundary(index - 1)) {
      const strong = text[index + 1] === "*";
      const marker = strong ? "**" : "*";
      const from = index + marker.length;
      const close = text.indexOf(marker, from);
      const inner = close > from ? text.slice(from, close) : "";
      if (
        inner &&
        !/^\s|\s$|\n/.test(inner) &&
        !(strong ? false : inner.includes("*")) &&
        boundary(close + marker.length)
      ) {
        const content = inlineMarkup(inner);
        emit(
          index,
          close + marker.length,
          strong ? <strong>{content}</strong> : <em>{content}</em>,
        );
        index = close + marker.length - 1;
      } else if (strong) {
        index += 1;
      }
    } else if (
      (char === "h" || char === "w") &&
      boundary(index - 1) &&
      /^(?:https?:\/\/|www\.[\p{L}\p{N}])/u.test(text.slice(index, index + 8))
    ) {
      let end = index;
      while (end < text.length && !URL_END.test(text[end]!)) end++;
      const raw = withoutTrailingPunctuation(text.slice(index, end));
      const href = webUrl(char === "w" ? `https://${raw}` : raw);
      if (href) {
        emit(index, index + raw.length, <Link href={href}>{raw}</Link>);
        index += raw.length - 1;
      }
    }
  }
  if (plain < text.length) out.push(text.slice(plain));
  return out;
}

/** Applies inline markup to the string children, leaving elements as they are. */
export function Inline({ children }: { children?: ReactNode }) {
  return (
    <>
      {Children.map(children, (child) => (typeof child === "string" ? inlineMarkup(child) : child))}
    </>
  );
}
