import { registrableDomain } from "@rakazo/core/egress";
import { JSDOM } from "jsdom";
import type { ResolveHostname } from "./network-address.js";
import { fetchSafeWebBytes } from "./web-ssrf.js";

const PAGE_MAX_BYTES = 256 * 1024;
const ICON_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = [80, 443] as const;
const MAX_ICON_FETCHES = 3;
const MAX_CONCURRENT = 4;
const MAX_WAITING = 32;
const MAX_WAIT_MS = 4_000;
/** One budget for a whole lookup, so a slow site cannot hold a slot for every fetch's timeout. */
const LOOKUP_DEADLINE_MS = 8_000;
const MAX_CACHED_ORIGINS = 2_000;
/**
 * Icons are usually a few KB, but a noisy 64 px PNG can reach about 22 KB as base64, so the origin
 * count alone could let anyone who posts links to many hosts grow the cache past 40 MB.
 */
const MAX_CACHED_ICON_BYTES = 16 * 1024 * 1024;
const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 24 * 60 * 60 * 1000;
/** Larger declared images are refused before their pixels are decoded. */
const MAX_INPUT_PIXELS = 1024 * 1024;
const ICO_MAX_SIDE = 256;
const OUTPUT_SIZE = 64;

/**
 * `icon` is a small `data:image/...` URL, or null when there is none to show. `retry` marks a
 * null that only means the server was too busy to look, so the client may ask again later.
 */
export type FaviconAnswer = { icon: string | null; retry?: true };

export type FaviconResolver = {
  favicon(origin: string): Promise<FaviconAnswer>;
};

export type FaviconResolverOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  now?: () => number;
  /** Test seams for the queue and deadline; the defaults suit production. */
  limits?: {
    maxWaiting?: number;
    maxWaitMs?: number;
    deadlineMs?: number;
    maxCachedIconBytes?: number;
  };
  /** Test seam for turning fetched bytes into an icon; defaults to `faviconDataUrl`. */
  decode?: (bytes: Uint8Array) => Promise<string | null>;
};

/**
 * Resolves site icons on the server so clients never contact the linked site or a third-party
 * icon service. Only the registrable domain's origin is fetched (its root page, then /favicon.ico),
 * never the subdomain or path a message linked to: either can carry data a link was built to leak,
 * and a path can trigger one-time actions. Every hop goes
 * through the SSRF-checked fetch, and results are cached per origin, misses included.
 */
export function createFaviconResolver(options: FaviconResolverOptions = {}): FaviconResolver {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { icon: string | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<FaviconAnswer>>();
  const limit = concurrencyLimit(
    MAX_CONCURRENT,
    options.limits?.maxWaiting ?? MAX_WAITING,
    options.limits?.maxWaitMs ?? MAX_WAIT_MS,
  );
  const deadlineMs = options.limits?.deadlineMs ?? LOOKUP_DEADLINE_MS;
  const maxCachedIconBytes = options.limits?.maxCachedIconBytes ?? MAX_CACHED_ICON_BYTES;
  let cachedIconBytes = 0;

  const forget = (origin: string) => {
    cachedIconBytes -= cache.get(origin)?.icon?.length ?? 0;
    cache.delete(origin);
  };
  // Least recently used first: Map order, refreshed on every hit.
  const remember = (origin: string, icon: string | null) => {
    forget(origin);
    cache.set(origin, { icon, expiresAt: now() + (icon ? FOUND_TTL_MS : MISSING_TTL_MS) });
    cachedIconBytes += icon?.length ?? 0;
    while (cache.size > MAX_CACHED_ORIGINS || cachedIconBytes > maxCachedIconBytes) {
      forget(cache.keys().next().value!);
    }
  };

  return {
    async favicon(input) {
      const origin = faviconOrigin(input);
      if (!origin) return { icon: null };
      const cached = cache.get(origin);
      if (cached && cached.expiresAt > now()) {
        cache.delete(origin);
        cache.set(origin, cached);
        return { icon: cached.icon };
      }
      const pending = inFlight.get(origin);
      if (pending) return pending;
      // A request turned away by a full queue is not a miss: it is not remembered, and the
      // answer tells the client to ask again later.
      const lookup = limit(() =>
        resolveFavicon(origin, options, AbortSignal.timeout(deadlineMs)).catch(() => null),
      )
        .then((result): FaviconAnswer => {
          if (result === BUSY) return { icon: null, retry: true };
          remember(origin, result);
          return { icon: result };
        })
        .finally(() => inFlight.delete(origin));
      inFlight.set(origin, lookup);
      return lookup;
    },
  };
}

/**
 * The origin whose icon is fetched, or undefined for anything that is not a bare http(s) origin on
 * its default port. It is the site's registrable domain (`docs.example.com` asks `example.com`), so
 * whatever a link puts in its subdomain never reaches DNS or the site from here.
 */
export function faviconOrigin(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.port || url.href !== `${url.origin}/`) return undefined;
  const site = registrableDomain(url.hostname);
  return site ? `${url.protocol}//${site}` : undefined;
}

async function resolveFavicon(
  origin: string,
  options: FaviconResolverOptions,
  signal: AbortSignal,
): Promise<string | null> {
  const fetchOptions = {
    fetch: options.fetch,
    resolveHostname: options.resolveHostname,
    signal,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    allowedPorts: ALLOWED_PORTS,
  };
  const page = await fetchSafeWebBytes(`${origin}/`, {
    ...fetchOptions,
    maxBytes: PAGE_MAX_BYTES,
    truncate: true,
  }).catch(() => undefined);
  const candidates = page ? iconCandidates(new TextDecoder().decode(page.body), page.url) : [];
  // After a redirect to another host (x.com to www.x.com, say), the icon lives where the page
  // ended up. That origin already passed the SSRF checks, and the fallback fetch is checked again.
  const fallback = `${page ? new URL(page.url).origin : origin}/favicon.ico`;
  if (!candidates.includes(fallback)) candidates.push(fallback);

  for (const candidate of candidates.slice(0, MAX_ICON_FETCHES)) {
    if (signal.aborted) return null;
    const image = await fetchSafeWebBytes(candidate, {
      ...fetchOptions,
      maxBytes: ICON_MAX_BYTES,
      headers: { accept: "image/png,image/x-icon,image/*;q=0.8" },
    }).catch(() => undefined);
    // The bytes decide the format, whatever type the server declared: only a raster image
    // that sniffs as one is used, so SVG and HTML never are.
    if (!image) continue;
    // Decoding counts against the same deadline as the fetches.
    const icon = await untilAborted((options.decode ?? faviconDataUrl)(image.body), signal);
    if (icon) return icon;
  }
  return null;
}

/** Icon URLs a page declares, in document order, apple-touch icons after plain ones. SVG is skipped. */
export function iconCandidates(html: string, pageUrl: string): string[] {
  const icons: string[] = [];
  const touchIcons: string[] = [];
  const document = JSDOM.fragment(html);
  const base = documentBase(document, pageUrl);
  for (const link of document.querySelectorAll("link")) {
    const attributes = Object.fromEntries(
      Array.from(link.attributes, ({ name, value }) => [name, value]),
    );
    const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/);
    const href = attributes.href?.trim();
    if (!href || (attributes.type ?? "").toLowerCase().includes("svg")) continue;
    const list = rel.includes("icon")
      ? icons
      : rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")
        ? touchIcons
        : undefined;
    if (!list) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.pathname.toLowerCase().endsWith(".svg")) continue;
    if (!icons.includes(url.href) && !touchIcons.includes(url.href)) list.push(url.href);
  }
  return [...icons, ...touchIcons];
}

/**
 * What relative icon links resolve against: the first `<base href>`, as a browser would, when it is
 * an http(s) URL, else the page itself. This widens nothing: a page can already name an icon on any
 * public host, and every icon URL still passes the same SSRF and port checks.
 */
function documentBase(document: DocumentFragment, pageUrl: string): string {
  const href = document.querySelector("base[href]")?.getAttribute("href") ?? undefined;
  if (href === undefined) return pageUrl;
  try {
    const base = new URL(href.trim(), pageUrl);
    return base.protocol === "http:" || base.protocol === "https:" ? base.href : pageUrl;
  } catch {
    return pageUrl;
  }
}

type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "ico";

function sniffImage(bytes: Uint8Array): ImageFormat | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && ascii(1, 4) === "PNG" && bytes[0] === 0x89) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
  return undefined;
}

/**
 * Turn fetched bytes into a data URL every client can draw: always a 64 px PNG, since Android
 * cannot decode ICO. Large declared images are refused before their pixels are decoded.
 */
export async function faviconDataUrl(bytes: Uint8Array): Promise<string | null> {
  const format = sniffImage(bytes);
  if (!format) return null;
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  try {
    let image: ReturnType<typeof sharp>;
    if (format === "ico") {
      const entry = largestIcoImage(bytes);
      if (!entry) return null;
      if (sniffImage(entry) === "png") {
        image = sharp(entry, { limitInputPixels: MAX_INPUT_PIXELS });
      } else {
        const bitmap = decodeIcoBitmap(entry);
        if (!bitmap) return null;
        image = sharp(bitmap.rgba, {
          raw: { width: bitmap.width, height: bitmap.height, channels: 4 },
        });
      }
    } else {
      image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    }
    const { width = 0, height = 0 } = await image.metadata();
    if (width <= 1 || height <= 1) return null;
    const png = await image
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // Truncated, corrupt or over the pixel limit.
    return null;
  }
}

/**
 * The biggest image in an ICO, or undefined when the file is malformed or any image in it is over
 * 256 px. Each entry's own header is read, not the directory's size bytes, which can lie.
 */
function largestIcoImage(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length < 6) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (count === 0 || count > 32 || bytes.length < 6 + count * 16) return undefined;
  let largest: { image: Uint8Array; area: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const size = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (size < 24 || offset > bytes.length || size > bytes.length - offset) return undefined;
    const image = bytes.subarray(offset, offset + size);
    const dimensions = sniffImage(image) === "png" ? pngSize(image) : bmpHeader(image);
    if (!dimensions) return undefined;
    const { width, height } = dimensions;
    if (width < 1 || height < 1 || width > ICO_MAX_SIDE || height > ICO_MAX_SIDE) return undefined;
    if (!largest || width * height > largest.area) largest = { image, area: width * height };
  }
  return largest?.image;
}

function pngSize(image: Uint8Array): { width: number; height: number } | undefined {
  if (image.length < 24) return undefined;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * An ICO bitmap's BITMAPINFOHEADER. It has no file header, its rows run bottom up, and its height
 * counts the colour rows and the 1-bit transparency mask together.
 */
function bmpHeader(image: Uint8Array) {
  if (image.length < 40) return undefined;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const headerSize = view.getUint32(0, true);
  const width = view.getInt32(4, true);
  const doubledHeight = view.getInt32(8, true);
  const bitCount = view.getUint16(14, true);
  const compression = view.getUint32(16, true);
  const colorsUsed = view.getUint32(32, true);
  if (headerSize < 40 || headerSize > image.length || doubledHeight <= 0) return undefined;
  return {
    headerSize,
    width,
    height: Math.floor(doubledHeight / 2),
    bitCount,
    compression,
    colorsUsed,
  };
}

/** Uncompressed 1, 4, 8, 24 and 32-bit ICO bitmaps as RGBA, or undefined for anything else. */
export function decodeIcoBitmap(
  image: Uint8Array,
): { width: number; height: number; rgba: Uint8Array } | undefined {
  const header = bmpHeader(image);
  if (header?.compression !== 0) return undefined;
  const { headerSize, width, height, bitCount, colorsUsed } = header;
  if (width < 1 || height < 1 || width > ICO_MAX_SIDE || height > ICO_MAX_SIDE) return undefined;
  if (![1, 4, 8, 24, 32].includes(bitCount)) return undefined;
  const paletteSize = bitCount <= 8 ? colorsUsed || 2 ** bitCount : 0;
  if (paletteSize > 2 ** bitCount) return undefined;
  const colorStride = Math.ceil((width * bitCount) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const colorStart = headerSize + paletteSize * 4;
  const maskStart = colorStart + colorStride * height;
  if (maskStart > image.length) return undefined;
  // A 32-bit image may carry its own alpha and leave the mask out; every other depth needs it.
  const hasMask = maskStart + maskStride * height <= image.length;
  if (!hasMask && bitCount !== 32) return undefined;

  const rgba = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let row = 0; row < height; row += 1) {
    const colorRow = colorStart + (height - 1 - row) * colorStride;
    const maskRow = maskStart + (height - 1 - row) * maskStride;
    for (let x = 0; x < width; x += 1) {
      const out = (row * width + x) * 4;
      let blue: number;
      let green: number;
      let red: number;
      let alpha = 255;
      if (bitCount >= 24) {
        const pixel = colorRow + x * (bitCount / 8);
        blue = image[pixel]!;
        green = image[pixel + 1]!;
        red = image[pixel + 2]!;
        if (bitCount === 32) {
          alpha = image[pixel + 3]!;
          if (alpha > 0) anyAlpha = true;
        }
      } else {
        const bit = x * bitCount;
        const byte = image[colorRow + (bit >> 3)]!;
        const index = (byte >> (8 - bitCount - (bit & 7))) & (2 ** bitCount - 1);
        if (index >= paletteSize) return undefined;
        const color = headerSize + index * 4;
        blue = image[color]!;
        green = image[color + 1]!;
        red = image[color + 2]!;
      }
      const masked = hasMask && (image[maskRow + (x >> 3)]! >> (7 - (x & 7))) & 1;
      rgba.set([red, green, blue, masked ? 0 : alpha], out);
    }
  }
  // Older 32-bit icons leave the alpha bytes at zero and rely on the mask alone.
  if (bitCount === 32 && !anyAlpha) {
    if (!hasMask) return undefined;
    for (let row = 0; row < height; row += 1) {
      const maskRow = maskStart + (height - 1 - row) * maskStride;
      for (let x = 0; x < width; x += 1) {
        const masked = (image[maskRow + (x >> 3)]! >> (7 - (x & 7))) & 1;
        rgba[(row * width + x) * 4 + 3] = masked ? 0 : 255;
      }
    }
  }
  return { width, height, rgba };
}

/** The promise's value, or null once the signal aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T | null>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(
        (value) => resolve(value),
        () => resolve(null),
      )
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const BUSY = Symbol("busy");

/** At most `max` tasks at once; a bounded number wait a bounded time, the rest are BUSY. */
function concurrencyLimit(max: number, maxWaiting: number, maxWaitMs: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    // Hand the slot straight to the next waiter so a newcomer cannot slip in between.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async <T>(task: () => Promise<T>): Promise<T | typeof BUSY> => {
    if (active < max) {
      active += 1;
    } else {
      if (waiting.length >= maxWaiting) return BUSY;
      const admitted = await new Promise<boolean>((resolve) => {
        const admit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(admit), 1);
          resolve(false);
        }, maxWaitMs);
        waiting.push(admit);
      });
      if (!admitted) return BUSY;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}
