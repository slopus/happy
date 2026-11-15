/** Longest a server's Retry-After may park a client loop. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** The HTTP status a failed request carried, if it got a response at all. */
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const { status } = error;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * Whether asking again can succeed. A failure without a response (the network, a timeout, a
 * dropped stream) can, as can 5xx, 429, and 408. Any other status is the server's answer to this
 * request — signed out, forbidden, gone, or this build no longer supported — and repeating the
 * request only polls the server.
 */
export function isRetryableError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === undefined || status < 400) return true;
  return status >= 500 || status === 429 || status === 408;
}

/** Retry-After as delta-seconds or an HTTP date, in milliseconds from `now`. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/** Between half of `ms` and all of it, so clients that failed together retry apart. */
export function jitterMs(ms: number, random: () => number = Math.random): number {
  return Math.round(ms - (random() * ms) / 2);
}

/**
 * Wait the server asked for (an error's `retryAfterMs`), otherwise the caller's backoff, jittered
 * after a failure. Without a failure the caller's own interval stands.
 */
export function retryDelayMs(
  error: unknown,
  backoffMs: number,
  random: () => number = Math.random,
): number {
  const asked =
    typeof error === "object" && error !== null && "retryAfterMs" in error
      ? error.retryAfterMs
      : undefined;
  if (typeof asked === "number" && Number.isFinite(asked) && asked >= 0) {
    return Math.min(Math.max(asked, backoffMs), MAX_RETRY_AFTER_MS);
  }
  return error === undefined ? backoffMs : jitterMs(backoffMs, random);
}

/** Longest a client waits to reopen a live stream that ended after it was open. */
export const RECONNECT_SPREAD_MS = 5_000;

/**
 * Wait before reopening a live stream that ended after it was open. A deploy ends every client's
 * stream at once, so each picks its own moment within a few seconds instead of all returning
 * together. A wait the server asked for still stands.
 */
export function reconnectDelayMs(error: unknown, random: () => number = Math.random): number {
  return Math.max(retryDelayMs(error, 0), Math.round(random() * RECONNECT_SPREAD_MS));
}
