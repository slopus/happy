// Same policy as the web preview: nothing loads from the network, so a script
// cannot send what it reads to a remote image or font URL.
export const SANDBOXED_ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

const PLAIN_HTML_DOCTYPE = /^\s*<!doctype\s+html\s*>/i;

/**
 * The CSP is a second layer, not the isolation boundary: on web that is the iframe's
 * `sandbox="allow-scripts"` (no `allow-same-origin`); on native it is the WebView never
 * sharing the app's cookies/storage and being blocked from navigating. Within that
 * boundary the CSP still blocks outbound network requests a script might attempt.
 */
export function withSandboxedArtifactCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOXED_ARTIFACT_CSP}">`;
  const leadingDoctype = html.match(PLAIN_HTML_DOCTYPE);
  if (!leadingDoctype) return `<!DOCTYPE html>${meta}${html}`;
  const end = leadingDoctype[0].length;
  return `${html.slice(0, end)}${meta}${html.slice(end)}`;
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/** Served by the API; the viewer inlines it, since the sandbox policy loads nothing. */
export const PAGE_RUNTIME_PATH = "/api/v1/assets/page-runtime.js";

/**
 * A page as one self-contained document for the same sandboxed viewers: the runtime
 * and a boot script carrying the page's compiled code. `<` is escaped in the JSON so no page
 * text can close the script element.
 */
export function pageViewerDocument(input: {
  runtime: string;
  /** The page compiled for the viewer, as the API returns it. */
  code: string;
  theme: "light" | "dark";
  errorTitle: string;
  /** The host surface the page sits on, as a hex colour; it paints behind the page on screen. */
  surface?: string;
  /** A touch tablet or phone, where pages sit closer to the edge. */
  touch?: boolean;
  /** The host can put a page's reply in a chat composer beside it; public pages have none. */
  reply?: boolean;
  /** Pixels the host covers at the bottom (a docked composer); bottom bars and the end clear it. */
  bottomInset?: number;
  /** The reader's app language, for the kit's own words when the page does not set `lang`. */
  lang?: string;
}): string {
  const boot = JSON.stringify({
    code: input.code,
    theme: input.theme,
    errorTitle: input.errorTitle,
    lang: input.lang,
  }).replace(/</g, "\\u003c");
  const inset =
    input.bottomInset !== undefined && Number.isFinite(input.bottomInset) && input.bottomInset > 0
      ? `<style>:root{--rk-bottom-inset:${Math.round(input.bottomInset)}px}</style>`
      : "";
  return [
    `<!DOCTYPE html><html${input.touch ? " data-touch" : ""}${input.reply ? " data-reply" : ""}><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<script>${input.runtime}</script>`,
    input.surface !== undefined && HEX_COLOR.test(input.surface)
      ? `<style>@media screen{:root[data-theme]{--background:${input.surface}}}</style>`
      : "",
    inset,
    "</head>",
    `<body><div id="root"></div><script>RakazoPage.mount(${boot})</script></body></html>`,
  ].join("");
}

/** A page reply's text on one line, as the chat's composer takes it; null when unusable. */
export function pageReplyText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean && clean.length <= 300 ? clean : null;
}

/** A page's copy buttons send at most this much; the kit refuses longer text before asking. */
export const PAGE_COPY_MAX_LENGTH = 20_000;

/**
 * Text a page asked the app to put on the clipboard, which the sandbox cannot reach on every
 * browser or WebView. The app only ever writes it: no page message reads the clipboard back.
 */
export function pageCopyRequest(data: unknown): { id: string; text: string } | null {
  if (!data || typeof data !== "object") return null;
  const { type, id, text } = data as { type?: unknown; id?: unknown; text?: unknown };
  if (type !== "rakazo-page:copy" || typeof id !== "string" || typeof text !== "string")
    return null;
  if (id.length === 0 || id.length > 64 || text.length === 0) return null;
  return text.length <= PAGE_COPY_MAX_LENGTH ? { id, text } : null;
}

/** A web or mail link a page asked the app to open; anything else stays inside the page. */
export function pageLinkRequest(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== "rakazo-page:open-link" || typeof url !== "string" || url.length > 4096) return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The answer a page's copy button waits for. */
export function pageCopyResult(id: string, ok: boolean) {
  return { type: "rakazo-page:copied", id, ok };
}
