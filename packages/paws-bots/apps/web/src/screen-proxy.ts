import type { IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import type { ScreenProxyTarget } from "@rakazo/core/node/screen-capability";
import {
  isScreenProxyTarget,
  SCREEN_RECHECK_MS,
  SCREEN_TARGET_ENDPOINT,
  SCREEN_UNCONFIRMED_MAX_MS,
} from "@rakazo/core/node/screen-capability";
import { SCREEN_PROBE_PARAM } from "@rakazo/core/screen-reconnect";

/**
 * The computer is untrusted, so only what noVNC's pages and socket need reaches it. Anything else,
 * such as credentials an access proxy in front of Rakazo expects, stays here.
 */
const FORWARDED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "origin",
  "pragma",
  "range",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

/**
 * Stock noVNC builds its socket URL as host + "/" + path, so the absolute capability path arrives
 * as "//novnc/...". Collapse leading slashes so that socket reaches the proxy instead of hanging.
 */
export function novncRequestPath(url: string | undefined): string | null {
  const path = url?.replace(/^\/{2,}/, "/");
  return path?.startsWith("/novnc/") ? path : null;
}

/** Fail closed when the authoritative lifecycle check is unavailable. */
export async function resolveNovncTarget(
  url: string | undefined,
  secret: string,
  api: string,
  onFailure?: (reason: ScreenTargetFailure) => void,
): Promise<ScreenProxyTarget | null> {
  if (!url?.startsWith("/novnc/session/")) {
    onFailure?.("invalid_path");
    return null;
  }
  try {
    const response = await fetch(new URL(SCREEN_TARGET_ENDPOINT, api), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: url }),
    });
    if (!response.ok) {
      // The authority refuses with 403; a server error, timeout or rate limit is it being down.
      onFailure?.(
        response.status >= 500 || response.status === 408 || response.status === 429
          ? "authority_unavailable"
          : "authority_rejected",
      );
      return null;
    }
    let target: unknown;
    try {
      target = await response.json();
    } catch (error) {
      onFailure?.(
        error instanceof SyntaxError ? "invalid_authority_response" : "authority_unavailable",
      );
      return null;
    }
    if (isScreenProxyTarget(target)) return target;
    onFailure?.("invalid_authority_response");
    return null;
  } catch {
    onFailure?.("authority_unavailable");
    return null;
  }
}

/**
 * For a status-only probe, the screen URL it asks about (without the probe mark); null for an
 * ordinary request. A probe is answered by `screenProbeStatus` and never reaches the computer.
 */
export function screenProbePath(url: string | undefined): string | null {
  const queryAt = url?.indexOf("?") ?? -1;
  if (!url || queryAt < 0) return null;
  const mark = `${SCREEN_PROBE_PARAM}=1`;
  const pairs = url.slice(queryAt + 1).split("&");
  if (!pairs.includes(mark)) return null;
  // Only the mark goes; the rest of the URL is checked exactly as the screen page sends it.
  const rest = pairs.filter((pair) => pair !== mark);
  return rest.length ? `${url.slice(0, queryAt)}?${rest.join("&")}` : url.slice(0, queryAt);
}

/** Whether the screen's computer accepts a connection at all; nothing is sent to it. */
export function screenUpstreamReachable(target: ScreenProxyTarget, timeoutMs = 1_000) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: target.hostname, port: target.port });
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * A probe's whole answer: let through, refused, the API couldn't be asked, or the computer's
 * screen isn't taking connections (502, as while its screen server restarts).
 */
export function screenProbeStatus(
  target: ScreenProxyTarget | null,
  reason: ScreenTargetFailure | undefined,
  reachable = true,
) {
  if (!target) return screenRefusal(reason).status;
  return reachable ? 204 : 502;
}

/**
 * What the proxy answers when a screen request isn't let through. It is refused either way; an
 * authority that didn't answer just hasn't judged the capability, so it reads as unavailable.
 */
export function screenRefusal(reason: ScreenTargetFailure | undefined) {
  return reason === "authority_unavailable"
    ? { status: 503, body: "Screen unavailable" }
    : { status: 403, body: "Invalid or expired screen capability" };
}

export type ScreenTargetFailure =
  | "invalid_path"
  | "authority_rejected"
  | "invalid_authority_response"
  | "authority_unavailable";

/**
 * Headers for the provider request. The provider's own credentials replace the browser's, and the
 * browser's Origin becomes the provider's: Boat refuses cross-origin WebSockets, and this proxy has
 * already authorized the request with the sealed capability.
 */
export function safeProxyHeaders(
  headers: IncomingHttpHeaders,
  target?: Pick<ScreenProxyTarget, "protocol" | "hostname" | "port" | "headers">,
) {
  const forwarded: IncomingHttpHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return value != null && FORWARDED_HEADERS.has(key.toLowerCase());
    }),
  );
  if (target && forwarded.origin) forwarded.origin = screenTargetOrigin(target);
  return { ...forwarded, ...target?.headers };
}

function screenTargetOrigin(target: Pick<ScreenProxyTarget, "protocol" | "hostname" | "port">) {
  const defaultPort = target.protocol === "https:" ? 443 : 80;
  return `${target.protocol}//${target.hostname}${target.port === defaultPort ? "" : `:${target.port}`}`;
}

/** What a recheck of an open screen found. */
export type ScreenCheck = "allowed" | "denied" | "unavailable";

export type ScreenRevokeReason = "denied" | "unconfirmed_window" | "expired";

/**
 * Recheck the capability an open screen started with. Only the same target counts as a yes: a
 * stream must never keep talking to a target the authority no longer names.
 */
export async function checkScreenAuthorization(
  url: string | undefined,
  secret: string,
  api: string,
  opened: ScreenProxyTarget,
): Promise<ScreenCheck> {
  let failure: ScreenTargetFailure | undefined;
  const target = await resolveNovncTarget(url, secret, api, (reason) => {
    failure = reason;
  });
  if (target) return sameScreenTarget(target, opened) ? "allowed" : "denied";
  return failure === "authority_unavailable" ? "unavailable" : "denied";
}

function sameScreenTarget(a: ScreenProxyTarget, b: ScreenProxyTarget) {
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.path === b.path &&
    a.interactive === b.interactive
  );
}

/** When the capability in a screen path runs out; the authority sealed this time with it. */
export function screenCapabilityExpiry(url: string | undefined): number | undefined {
  const expiresAt = Number(url?.match(/^\/novnc\/session\/(?:view|control)\/(\d+)\./)?.[1]);
  return Number.isSafeInteger(expiresAt) ? expiresAt : undefined;
}

/**
 * Recheck streams as well as new requests; no positive authorization cache. A refusal ends the
 * stream at once. An authority that can't answer is ridden out for a few seconds, measured from
 * when the last yes was asked for, and never past the capability's own expiry.
 */
export function watchScreenAuthorization(
  check: () => Promise<ScreenCheck>,
  revoke: (reason: ScreenRevokeReason) => void,
  options: {
    /** When the check that opened the stream was sent, on the monotonic clock. */
    confirmedAt?: number;
    /** When the capability runs out, on the wall clock it was sealed with. */
    expiresAt?: number;
    onUnavailable?: (consecutive: number) => void;
  } = {},
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let unconfirmed: ReturnType<typeof setTimeout>;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let unavailable = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(unconfirmed);
    clearTimeout(expiry);
  };
  const end = (reason: ScreenRevokeReason) => {
    if (stopped) return;
    stop();
    revoke(reason);
  };
  // Timers end the stream on time, whatever a slow or stuck check is doing. Elapsed time is
  // measured on the monotonic clock, so moving the wall clock can't stretch the window.
  const confirm = (sentAt: number) => {
    clearTimeout(unconfirmed);
    unconfirmed = setTimeout(
      () => end("unconfirmed_window"),
      Math.max(0, sentAt + SCREEN_UNCONFIRMED_MAX_MS - performance.now()),
    );
    unconfirmed.unref?.();
  };
  const tick = async () => {
    const sentAt = performance.now();
    let result: ScreenCheck = "denied";
    try {
      result = await check();
    } catch {
      /* Fail closed. */
    }
    if (stopped) return;
    if (result === "denied") return end("denied");
    if (result === "allowed") {
      confirm(sentAt);
      unavailable = 0;
    } else {
      unavailable += 1;
      options.onUnavailable?.(unavailable);
    }
    // The next check starts only once this one has ended.
    timer = setTimeout(tick, SCREEN_RECHECK_MS);
    timer.unref?.();
  };
  confirm(options.confirmedAt ?? performance.now());
  if (options.expiresAt !== undefined) {
    // Capped at the longest delay a timer takes; capabilities live far shorter than that.
    const left = Math.min(Math.max(0, options.expiresAt - Date.now()), 2 ** 31 - 1);
    expiry = setTimeout(() => end("expired"), left);
    expiry.unref?.();
  }
  timer = setTimeout(tick, SCREEN_RECHECK_MS);
  timer.unref?.();
  return stop;
}
