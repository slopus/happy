import { hostRuntimeOrigin } from "../paws/runtime";
import { t } from "@lingui/core/macro";
import { isLocalhostOrLoopbackIp } from "@rakazo/contracts";
import { COMPUTER_SCREEN_PATH } from "@rakazo/contracts/content-security-policy";
import { errorText } from "./user-error";

export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/** Only the latest request for the visible computer may replace its screen or error. */
export async function loadComputerScreen(options: {
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult) => void;
  fallbackError: string;
  timeoutMs?: number;
}): Promise<string | null> {
  let result: ComputerScreenResult;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const screen = await Promise.race([
      options.load(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(options.fallbackError)), options.timeoutMs ?? 45_000);
      }),
    ]);
    result = { url: screen.url, error: null };
  } catch (error) {
    result = {
      url: null,
      error: errorText(error, options.fallbackError),
    };
  }
  clearTimeout(deadline);
  if (!options.isCurrent()) return null;
  options.commit(result);
  return result.url;
}

export function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(hostRuntimeOrigin());
    // An embedded desktop is drawn by its Web SDK in a page this server serves. Its one-time login
    // code rides in the fragment so it never reaches a server log.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `${page.origin}${COMPUTER_SCREEN_PATH}#${parsed.searchParams.toString()}`;
    }
    // The server that served this page proxies /novnc/. Keep the frame on this origin even when the
    // API's WEB_ORIGIN names another host for it (localhost vs 127.0.0.1), as the CSP frames 'self'.
    if (parsed.pathname.startsWith("/novnc/")) {
      return `${page.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    const local = isLocalhostOrLoopbackIp(parsed.hostname);
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * An embedded screen URL carries a one-time login code, so every read of it differs. Reloading the
 * frame for a new code would open a second session that signs the first one out; the screen keeps
 * the URL it connected with until the desktop or the view changes.
 */
export function sameEmbeddedComputerScreen(current: string | null, next: string | null): boolean {
  if (!current || !next) return false;
  try {
    const a = new URL(current);
    const b = new URL(next);
    if (a.protocol === "http:" || a.protocol === "https:" || a.protocol !== b.protocol)
      return false;
    return ["desktop_id", "region_id", "view_only"].every(
      (name) => a.searchParams.get(name) === b.searchParams.get(name),
    );
  } catch {
    return false;
  }
}

export function screenIframeSandbox(url: string | null) {
  if (!url) return undefined;
  try {
    const pathname = new URL(url, window.location.href).pathname;
    return pathname.startsWith("/novnc/") || pathname === COMPUTER_SCREEN_PATH
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

/** Deduplicate only the boot request; callers can still take over and refresh. */
export async function bootComputerOnce<T>(
  inFlight: Map<string, symbol>,
  botId: string,
  boot: () => Promise<T>,
): Promise<T | undefined> {
  if (inFlight.has(botId)) return;
  const token = Symbol(botId);
  inFlight.set(botId, token);
  try {
    return await boot();
  } finally {
    if (inFlight.get(botId) === token) inFlight.delete(botId);
  }
}

/** A proxied screen's policy and expiry, which its capability path carries in the clear. */
export function proxiedScreenCapability(
  url: string | null,
): { policy: "view" | "control"; expiresAt: number } | null {
  const match = url ? /\/novnc\/session\/(view|control)\/(\d+)\./.exec(url) : null;
  return match ? { policy: match[1] as "view" | "control", expiresAt: Number(match[2]) } : null;
}

/**
 * The frames a screen draws. A held predecessor comes first, so React keeps its element in place
 * (a moved iframe reloads), then the live frame.
 */
export function screenFrames(
  key: string | undefined,
  url: string,
  held: { url: string; key: string } | null | undefined,
): Array<{ key: string; url: string; held: boolean }> {
  const live = { key: key ?? "screen", url, held: false };
  return held ? [{ ...held, held: true }, live] : [live];
}

/** Only pages the web proxy serves carry the shim that reports their state to the app. */
export function isProxiedScreenUrl(url: string | null): url is string {
  return screenIframeSandbox(url) !== undefined;
}

/** How long a framed screen may stay silent before the app treats it as not loaded. */
export const SCREEN_FRAME_LOAD_TIMEOUT_MS = 15_000;

export type ScreenFrameState = "loading" | "connecting" | "connected" | "failed" | "disconnected";

export interface ScreenFrameMessage {
  rakazoScreen: ScreenFrameState;
  detail?: string;
}

const SCREEN_FRAME_STATES: ReadonlySet<string> = new Set<ScreenFrameState>([
  "loading",
  "connecting",
  "connected",
  "failed",
  "disconnected",
]);

/** A state report posted by a framed screen page, or null for any other message. */
export function screenFrameMessage(data: unknown): ScreenFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const { rakazoScreen, detail } = data as Record<string, unknown>;
  if (typeof rakazoScreen !== "string" || !SCREEN_FRAME_STATES.has(rakazoScreen)) return null;
  const text = typeof detail === "string" ? detail.trim().slice(0, 200) : "";
  return { rakazoScreen: rakazoScreen as ScreenFrameState, ...(text ? { detail: text } : {}) };
}

/** Whether a report shows the page got past loading; a page stalled there is still silent. */
export function screenFrameStarted(message: ScreenFrameMessage): boolean {
  return message.rakazoScreen !== "loading";
}

/** The error a frame report means for the screen, or null while it is fine. */
export function screenFrameError(message: ScreenFrameMessage, fallback: string): string | null {
  if (message.rakazoScreen !== "failed" && message.rakazoScreen !== "disconnected") return null;
  return message.rakazoScreen === "disconnected" ? t`The screen connection closed.` : fallback;
}

/**
 * Cookies a screen probe may attach. The capability in the URL authorizes the screen, so a host
 * that is not this page never receives the session cookie. A same-origin http(s) probe includes
 * it: an identity-aware proxy in front of this app answers a cookie-less request with a redirect,
 * and `redirect: "manual"` hides that as an opaque redirect the probe would treat as a failed
 * screen. Other schemes, such as an embedded screen ticket, stay cookie-less.
 */
function screenProbeCredentials(url: string): RequestCredentials {
  const pageHref = pageLocationHref();
  if (!pageHref) return "omit";
  try {
    const target = new URL(url, pageHref);
    if (target.protocol !== "http:" && target.protocol !== "https:") return "omit";
    return target.origin === new URL(pageHref).origin ? "same-origin" : "omit";
  } catch {
    return "omit";
  }
}

function pageLocationHref(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const href = window.location?.href;
  return typeof href === "string" ? href : undefined;
}

/**
 * Ask the proxy for the page before framing it. A frame cannot say why it failed to load, so a
 * refused or unreachable screen would otherwise stay blank.
 */
export async function probeScreen(
  url: string,
  fallback: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      credentials: screenProbeCredentials(url),
      cache: "no-store",
      redirect: "manual",
    });
    if (response.ok) return null;
    // The proxy couldn't reach the API to check the screen: that's a connection problem.
    if (response.type === "opaqueredirect" || response.status === 503) return fallback;
    if (response.status === 403) return t`The screen link expired.`;
    const body = await response.text().catch(() => "");
    if (response.status === 502 && body.trim() === "Screen unavailable (upstream_timeout)") {
      return t`The screen did not respond.`;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * The screen page's status through the proxy's access check, or null if it couldn't be asked.
 * Only the status is read; the body is dropped unread.
 */
export async function probeScreenStatus(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetchImpl(url, {
      credentials: screenProbeCredentials(url),
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    void response.body?.cancel().catch(() => undefined);
    return response.type === "opaqueredirect" ? 0 : response.status;
  } catch {
    return null;
  }
}

/**
 * Whether a reconnected screen takes the keyboard back: only a screen that had it when it
 * dropped, and only if the user hasn't moved on. Focus anywhere else in the app, or the screen
 * failing, forgets it, and it happens at most once per drop.
 */
export function createScreenRefocus() {
  let pending = false;
  return {
    dropped(hadFocus: boolean) {
      pending = hadFocus;
    },
    forget() {
      pending = false;
    },
    /** On a reconnected screen's "connected": whether to give it the keyboard now. */
    connected(active: Element | null, frame: Element, body: Element | null): boolean {
      if (!pending) return false;
      pending = false;
      return !active || active === body || active === frame;
    },
  };
}
