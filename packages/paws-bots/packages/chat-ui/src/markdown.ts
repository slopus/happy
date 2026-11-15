/// <reference path="./linkify-it.d.ts" />

import type { MessageBlock } from "@rakazo/contracts";
import { urlSite } from "@rakazo/core/egress";
import LinkifyIt from "linkify-it";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
  /** Draws a mention link from `withMentions`; returning nothing leaves its plain name. */
  renderMention?: (id: string, name: string) => ReactNode;
  /** Opens a page linked as `[title](page:<pageId>)`; without it the title stays plain text. */
  onOpenPage?: (pageId: string) => void;
};

const PAGE_URL_PATTERN = /^page:([A-Za-z0-9_-]{1,64})$/;

/** The page id of a `page:<pageId>` link, if this href is one. */
export function markdownPageId(href: string | undefined): string | undefined {
  return href ? PAGE_URL_PATTERN.exec(href)?.[1] : undefined;
}

const MENTION_URL_PREFIX = "rakazo-mention:";

/** The id of a mention link, if this href is one. */
export function markdownMentionId(href: string | undefined): string | undefined {
  if (!href?.startsWith(MENTION_URL_PREFIX)) return undefined;
  try {
    return decodeURIComponent(href.slice(MENTION_URL_PREFIX.length)) || undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const mentionParser = unified().use(remarkParse).use(remarkGfm);

type MentionTrees = Map<string, ReturnType<typeof mentionParser.parse> | null>;

function rewriteOutsideCode(
  text: string,
  rewrite: (part: string) => string,
  trees: MentionTrees,
  skipLinks = false,
) {
  if (trees.get(text) === null) return text;
  try {
    const tree = trees.get(text) ?? mentionParser.parse(text);
    trees.set(text, tree);
    let result = "";
    let offset = 0;
    function visit(node: typeof tree | (typeof tree.children)[number]) {
      if (
        node.type === "link" ||
        node.type === "code" ||
        node.type === "inlineCode" ||
        (skipLinks &&
          ["link", "image", "linkReference", "imageReference", "definition"].includes(node.type))
      ) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) {
          const source = text.slice(start, end);
          result +=
            rewrite(text.slice(offset, start)) +
            (!skipLinks &&
            node.type === "link" &&
            node.url.toLowerCase().startsWith(MENTION_URL_PREFIX)
              ? rewrite(source)
              : source);
          offset = end;
        }
        return;
      }
      if ("children" in node) for (const child of node.children) visit(child);
    }
    visit(tree);
    return result + rewrite(text.slice(offset));
  } catch {
    trees.set(text, null);
    return text;
  }
}
const MODEL_MENTION_LINK = /\[([^\]\n]*)\]\(\s*<?rakazo-mention:[^)\n]*\)/gi;
const OPENS_WITH_BLOCK = /^\s*(#|>|\||```|~~~|[-*+]\s|\d+[.)]\s)/;

function linkFirstName(
  text: string,
  name: string,
  link: string,
  trees: MentionTrees,
): string | undefined {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "u");
  if (!pattern.test(text)) return undefined;
  let placed = false;
  const result = rewriteOutsideCode(
    text,
    (part) => {
      if (placed) return part;
      return part.replace(pattern, (_match, prefix: string) => {
        placed = true;
        return `${prefix}${link}`;
      });
    },
    trees,
    true,
  );
  return placed ? result : undefined;
}

/**
 * Markdown texts of one message naming each entry once as a mention link: at its first
 * appearance across the texts, or at the start of the first text when none names it.
 */
export function withMentions(
  texts: readonly string[],
  mentions: readonly { id: string; name: string }[],
): string[] {
  const trees: MentionTrees = new Map();
  // Only links placed here draw as mentions; ones already in the text keep just their name.
  const result = texts.map((text) =>
    rewriteOutsideCode(text, (part) => part.replace(MODEL_MENTION_LINK, "$1"), trees),
  );
  if (result.length === 0) return result;
  for (const mention of mentions) {
    const name = mention.name.trim();
    if (!name) continue;
    const link = `[${name.replace(/[\\[\]*_`<>]/g, "\\$&")}](${MENTION_URL_PREFIX}${encodeURIComponent(mention.id)})`;
    const placed = result.some((text, index) => {
      const linked = linkFirstName(text, name, link, trees);
      if (linked !== undefined) result[index] = linked;
      return linked !== undefined;
    });
    if (placed) continue;
    const firstIndex = result.findIndex((text) => trees.get(text) !== null);
    if (firstIndex === -1) continue;
    const first = result[firstIndex]!;
    result[firstIndex] = OPENS_WITH_BLOCK.test(first) ? `${link}\n\n${first}` : `${link} ${first}`;
  }
  return result;
}

/** Message blocks whose prose names each entry once as a mention link. Tool activity is left alone. */
export function withBlockMentions(
  blocks: readonly MessageBlock[],
  mentions: readonly { id: string; name: string }[],
): MessageBlock[] {
  const prose = blocks.flatMap((block, index) =>
    block.kind === "text" || (block.kind === "progress" && !block.activity) ? [index] : [],
  );
  const texts = withMentions(
    prose.map((index) => (blocks[index] as { text: string }).text),
    mentions,
  );
  return blocks.map((block, index) => {
    const prosePosition = prose.indexOf(index);
    return prosePosition === -1
      ? block
      : ({ ...block, text: texts[prosePosition] } as MessageBlock);
  });
}

type LinkifyRules = {
  set(options: { fuzzyLink: boolean }): unknown;
  add(schema: string, definition: null): unknown;
};

type LinkifyParser = {
  set(options: { linkify: boolean }): unknown;
  linkify: LinkifyRules;
};

type ExplicitLinkMatch = {
  index: number;
  lastIndex: number;
  url: string;
};

type ExplicitLinkify = LinkifyRules & {
  match(text: string): ExplicitLinkMatch[] | null;
};

function applyExplicitLinkRules(linkify: LinkifyRules) {
  linkify.set({ fuzzyLink: false });
  linkify.add("ftp:", null);
  linkify.add("//", null);
}

/**
 * Turn bare http(s) URLs and email addresses into links, as the web renderer's GFM autolinks
 * do. Bare domains stay text: fuzzy matching would also link file names like setup.py or
 * notes.md. ftp: and protocol-relative URLs stay text because sanitizeMarkdownUrl would not
 * open them.
 */
export function linkifyExplicitUrls<T extends LinkifyParser>(parser: T): T {
  parser.set({ linkify: true });
  applyExplicitLinkRules(parser.linkify);
  return parser;
}

const plainTextLinkify: ExplicitLinkify = new LinkifyIt();
applyExplicitLinkRules(plainTextLinkify);

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

export type PlainTextPart =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string }
  | { type: "page"; value: string; pageId: string };

// The link pageReply puts before a sent reply: `[title](page:<pageId>)`, title brackets escaped.
const PLAIN_PAGE_LINK = /\[((?:\\[\\[\]]|[^\\[\]\n])*)\]\(page:([A-Za-z0-9_-]{1,64})\)/g;

function appendPlainText(parts: PlainTextPart[], value: string) {
  if (!value) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    previous.value += value;
    return;
  }
  parts.push({ type: "text", value });
}

/**
 * User bubbles stay plain text: markdown remains characters, except a page link, which opens the
 * page as it does in bot messages. Links use the bot messages' autolinker, so a balanced
 * parenthesis stays inside the URL and one wrapping the prose does not.
 */
export function plainTextLinkParts(text: string): PlainTextPart[] {
  const parts: PlainTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PLAIN_PAGE_LINK)) {
    if (match.index > cursor) parts.push(...urlLinkParts(text.slice(cursor, match.index)));
    const value = match[1]!.replace(/\\([\\[\]])/g, "$1");
    parts.push({ type: "page", value, pageId: match[2]! });
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return urlLinkParts(text);
  if (cursor < text.length) parts.push(...urlLinkParts(text.slice(cursor)));
  return parts;
}

function urlLinkParts(text: string): PlainTextPart[] {
  const matches = plainTextLinkify.match(text);
  if (!matches || matches.length === 0) return [{ type: "text", value: text }];

  const parts: PlainTextPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor || match.lastIndex <= match.index) continue;
    const value = text.slice(match.index, match.lastIndex);
    const href = sanitizeMarkdownUrl(match.url);
    appendPlainText(parts, text.slice(cursor, match.index));
    if (!href) {
      appendPlainText(parts, value);
      cursor = match.lastIndex;
      continue;
    }
    parts.push({ type: "link", value, href });
    cursor = match.lastIndex;
  }

  appendPlainText(parts, text.slice(cursor));
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

export function sanitizeMarkdownUrl(url: string, allowRelative = false): string | undefined {
  const value = url.trim();
  const protocol = value.match(protocolPattern)?.[1]?.toLowerCase();

  if (protocol) return safeProtocols.has(protocol) ? value : undefined;
  if (
    allowRelative &&
    (value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("#"))
  ) {
    return value;
  }
  return undefined;
}

const httpUrlProtocols = new Set(["http:", "https:"]);

function markdownLinkBase(appOrigin?: string | null) {
  if (!appOrigin) return "https://app.invalid";
  try {
    return new URL(appOrigin).origin;
  } catch {
    return "https://app.invalid";
  }
}

export function markdownLinkRequiresConfirmation(url: string, appOrigin?: string | null): boolean {
  const value = url.trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, markdownLinkBase(appOrigin));
  } catch {
    return false;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return false;
  const explicitDestination = /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");
  if (!explicitDestination) return false;
  if (!appOrigin) return true;
  try {
    return parsed.origin !== new URL(appOrigin).origin;
  } catch {
    return true;
  }
}

/**
 * The site "Always open" trusts for a link: its registrable domain, so every subdomain is
 * included, while each tenant of a shared host stays its own site. The server stores the same.
 */
export function markdownLinkSite(url: string): string | undefined {
  return urlSite(url);
}

/** Whether a link shows the external-link prompt: it leaves the app to a site not trusted. */
export function markdownLinkNeedsPrompt(
  url: string,
  appOrigin?: string | null,
  trustedSites: readonly string[] = [],
): boolean {
  if (!markdownLinkRequiresConfirmation(url, appOrigin)) return false;
  const site = markdownLinkSite(url);
  return !site || !trustedSites.includes(site);
}

export type MarkdownLinkDisplayParts = {
  before: string;
  host: string;
  after: string;
};

export function markdownLinkDisplayParts(url: string): MarkdownLinkDisplayParts | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return undefined;
  const href = parsed.href;
  const authorityAt = href.indexOf("//") + 2;
  const userinfoLength =
    parsed.username || parsed.password
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`.length
      : 0;
  const hostAt = authorityAt + userinfoLength;
  return {
    before: href.slice(0, hostAt),
    host: parsed.host,
    after: href.slice(hostAt + parsed.host.length),
  };
}

const imageLinkProtocols = new Set(["http", "https"]);

export function sanitizeMarkdownImageUrl(url: string): string | undefined {
  const href = sanitizeMarkdownUrl(url);
  if (!href) return undefined;
  const protocol = href.match(protocolPattern)?.[1]?.toLowerCase();
  return protocol && imageLinkProtocols.has(protocol) ? href : undefined;
}

const inlineImagePattern = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z\d+/=]+$/i;
const MAX_INLINE_IMAGE_URL_LENGTH = 1024 * 1024;

/**
 * Markdown images in bot output never fetch on their own: an image URL can carry conversation
 * data to any host the moment a reply renders. Only embedded raster data renders at once; a
 * remote image waits for the reader's tap unless they turned on loading web images.
 */
export function inlineMarkdownImageSrc(url: string): string | undefined {
  const value = url.trim();
  return value.length <= MAX_INLINE_IMAGE_URL_LENGTH && inlineImagePattern.test(value)
    ? value
    : undefined;
}

/** A markdown image that may load on request, with the host its placeholder names. */
export function remoteMarkdownImage(url: string): { href: string; host: string } | undefined {
  const href = sanitizeMarkdownImageUrl(url);
  if (!href) return undefined;
  try {
    return { href, host: new URL(href).host };
  } catch {
    return undefined;
  }
}

/** Whether remote markdown images load without a tap. Apps provide the reader's device setting. */
export const RemoteImagesContext = createContext(false);

// Images the reader chose to load stay loaded for the session, even after a bubble remounts.
const loadedRemoteImages = new Set<string>();

export function remoteImageLoaded(href: string): boolean {
  return loadedRemoteImages.has(href);
}

/** The current URL only. A link that cannot open stays text, so its image is not requested. */
export function remoteImageRenders(
  href: string,
  loadRemote: boolean,
  rejectedLink: boolean,
): boolean {
  return !rejectedLink && (loadRemote || remoteImageLoaded(href));
}

export function markRemoteImageLoaded(href: string): void {
  loadedRemoteImages.add(href);
}

const SHORT_LINK_LABEL_MAX = 40;
const SHORT_LINK_PATH_MIN = 12;
// Control and format characters (bidi overrides, zero-width joiners and spaces, the BOM) that a
// decoded path could use to disguise itself.
const HIDDEN_PATH_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function httpUrl(href: string): URL | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function decodedUrl(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function comparableUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * The words a link shows. An author's label stays as written; a bare URL (an autolink, or a
 * label that just repeats the address) shortens to host and path, like `x.com/elonmusk`. The
 * host is what tells a reader where the link goes, so it is never cut and stays in its ASCII
 * (punycode) form; only a long path is trimmed.
 */
export function linkLabel(text: string, href: string): string {
  const url = httpUrl(href);
  // Some parsers show an autolink with its escapes decoded (`caf%C3%A9` as `café`), so a label
  // that matches the decoded address is bare too.
  const label = comparableUrl(text);
  if (!url || (label !== comparableUrl(href) && label !== comparableUrl(decodedUrl(href)))) {
    return text;
  }
  const host = url.host.replace(/^www\./i, "");
  const path = decodedUrl(url.pathname.replace(/\/+$/, "")).replace(HIDDEN_PATH_CHARACTERS, "");
  const room = Math.max(SHORT_LINK_LABEL_MAX - host.length, SHORT_LINK_PATH_MIN);
  if (path.length <= room) return `${host}${path}`;
  let end = room - 1;
  const before = path.charCodeAt(end - 1);
  const after = path.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return `${host}${path.slice(0, end)}…`;
}

/** The origin a link's site icon is looked up by, or undefined for links that get no icon. */
export function linkFaviconOrigin(href: string): string | undefined {
  return httpUrl(href)?.origin;
}

/**
 * Where link icons come from. Apps load them through the Rakazo API, which fetches and caches
 * them, so a device never contacts the linked site or an icon service. `globe` is the native
 * fallback glyph; web draws its own.
 */
export type LinkFavicons = {
  /** Cache scope for the API serving these answers. */
  endpoint?: string;
  /** `retry` means the server was too busy to look, not that the site has no icon. */
  load(origin: string): Promise<{ icon: string | null; retry?: boolean }>;
  globe?: ReactNode;
};

export const LinkFaviconsContext = createContext<LinkFavicons | null>(null);

/** True while a reply streams: a half-written autolink host must not be looked up. */
export const LinkFaviconsPausedContext = createContext(false);

// One answer per API endpoint and origin for the session, shared by links on screen.
const linkFavicons = new Map<string, string | null>();
const pendingFavicons = new Set<string>();
// A failed lookup (an older server without the procedure, or no connection) is not asked again
// by every link that mounts, but is retried after a while so a brief outage does not last all day.
const FAILED_FAVICON_RETRY_MS = 5 * 60 * 1000;
const failedFavicons = new Map<string, number>();
// A busy server is asked again a few times, a little later, while the link stays on screen.
const BUSY_FAVICON_RETRY_MS = 10_000;
const BUSY_FAVICON_ATTEMPTS = 3;
const busyFaviconRetries = new Map<string, ReturnType<typeof setTimeout>>();
// How many links to each origin are on screen; a busy retry stops once none are.
const mountedFaviconLinks = new Map<string, number>();
const faviconListeners = new Set<() => void>();

function setLinkFavicon(origin: string, icon: string | null) {
  linkFavicons.set(origin, icon);
  for (const listener of faviconListeners) listener();
}

function subscribeLinkFavicons(listener: () => void) {
  faviconListeners.add(listener);
  return () => {
    faviconListeners.delete(listener);
  };
}

/** The origin stays pending across busy retries, so links that mount meanwhile do not ask too. */
function requestLinkFavicon(source: LinkFavicons, origin: string, key: string, attempt: number) {
  pendingFavicons.add(key);
  source.load(origin).then(
    (answer) => {
      const shown = mountedFaviconLinks.has(key);
      if (answer.retry && shown && attempt < BUSY_FAVICON_ATTEMPTS) {
        const retry = () => {
          busyFaviconRetries.delete(key);
          requestLinkFavicon(source, origin, key, attempt + 1);
        };
        busyFaviconRetries.set(key, setTimeout(retry, BUSY_FAVICON_RETRY_MS));
        return;
      }
      pendingFavicons.delete(key);
      // A busy answer for links no longer on screen is dropped; the next one to mount asks.
      if (answer.retry && shown) failedFavicons.set(key, Date.now());
      else if (!answer.retry) setLinkFavicon(key, answer.icon);
    },
    () => {
      pendingFavicons.delete(key);
      failedFavicons.set(key, Date.now());
    },
  );
}

/** The icon for a link once the API has one, and a way to drop an image that turns out unusable. */
export function useLinkFavicon(href: string): { icon: string | null; unusable: () => void } {
  const source = useContext(LinkFaviconsContext);
  const paused = useContext(LinkFaviconsPausedContext);
  const origin = linkFaviconOrigin(href);
  const key = JSON.stringify([source?.endpoint ?? "", origin]);
  const snapshot = () => (origin ? (linkFavicons.get(key) ?? null) : null);
  const icon = useSyncExternalStore(subscribeLinkFavicons, snapshot, snapshot);
  useEffect(() => {
    if (!origin) return;
    mountedFaviconLinks.set(key, (mountedFaviconLinks.get(key) ?? 0) + 1);
    return () => {
      const left = (mountedFaviconLinks.get(key) ?? 1) - 1;
      if (left > 0) {
        mountedFaviconLinks.set(key, left);
        return;
      }
      mountedFaviconLinks.delete(key);
      const retry = busyFaviconRetries.get(key);
      if (retry === undefined) return;
      clearTimeout(retry);
      busyFaviconRetries.delete(key);
      pendingFavicons.delete(key);
    };
  }, [key, origin]);
  useEffect(() => {
    if (!source || paused || !origin) return;
    if (linkFavicons.has(key) || pendingFavicons.has(key)) return;
    if (Date.now() - (failedFavicons.get(key) ?? -Infinity) < FAILED_FAVICON_RETRY_MS) return;
    requestLinkFavicon(source, origin, key, 1);
  }, [source, paused, origin, key]);
  return {
    icon,
    unusable: () => {
      if (origin) setLinkFavicon(key, null);
    },
  };
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      if (marker === "`" && (match[2] ?? "").includes("`")) continue;
      openFence = { marker, length: match[1].length };
      continue;
    }

    if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      openFence = undefined;
    }
  }

  return openFence ? `${markdown}\n${openFence.marker.repeat(openFence.length)}` : markdown;
}

/**
 * A fence explicitly marked as plain text, such as a draft email: it wraps in the body font. Every
 * other fence, including one with no language, keeps the monospaced font and sideways scrolling.
 */
export function isProseFence(language: string): boolean {
  return ["text", "txt", "plaintext"].includes(language.toLowerCase());
}
