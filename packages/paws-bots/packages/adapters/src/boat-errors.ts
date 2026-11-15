import { setTimeout as delay } from "node:timers/promises";
import type { FetchError, ResponseError } from "@boatdev/sdk";
import {
  SandboxProviderAccountError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { readBodyCapped } from "./web-ssrf.js";

const MAX_BOAT_ERROR_RESPONSE_BYTES = 16 * 1024;
const BOAT_ERROR_RESPONSE_TIMEOUT_MS = 2_000;

/** The SDK loads only when Boat is configured; its error classes are read after a call fails. */
export const boatSdk = () => import("@boatdev/sdk");

/** A failed Boat response, shaped like the SDK's `ResponseError`, that keeps Boat's error code. */
export class BoatApiError extends Error implements ResponseError {
  override name = "ResponseError" as const;

  constructor(
    readonly response: Response,
    message: string,
    readonly code: string | undefined,
    /** How long Boat asked to wait before the next request, on a 429 that said. */
    readonly retryAfterMs?: number,
    /** The span a start limit counts over: `minute`, `hour`, or `day`. */
    readonly window?: string,
  ) {
    super(message);
  }
}

/** Boat's limit on API requests per minute from one IP address, across every endpoint. */
const BOAT_IP_RATE_LIMIT = "IP_RATE_LIMIT_EXCEEDED";
/** Boat counts requests and starts over a rolling minute. */
const BOAT_RATE_WINDOW_MS = 60_000;
/** Bounds a wait Boat names, so a malformed answer cannot hold every request for long. */
const BOAT_MAX_RETRY_AFTER_MS = 5 * 60_000;
/** Requests released together reach Boat over this long instead of in one burst. */
const BOAT_WAKE_SPREAD_MS = 1_000;

/**
 * Every Boat call from one provider waits here after Boat refuses this host's address for
 * sending too many requests, so parallel callers stop spending the shared budget until it refills.
 */
export class BoatRequestGate {
  private openAt = 0;

  async wait(signal?: AbortSignal): Promise<void> {
    for (let ms = this.openAt - Date.now(); ms > 0; ms = this.openAt - Date.now()) {
      await delay(spread(ms), undefined, { signal });
    }
  }

  close(ms: number): void {
    this.openAt = Math.max(this.openAt, Date.now() + ms);
  }
}

const BOAT_RETRY_DELAY_MS = 1_000;
// Failures before a TCP connection exists: the request never left this host.
const UNSENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
// 520-526 and 530 come from Cloudflare in front of Boat when it gets no usable answer from Boat.
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

/**
 * Keep HTTP failures actionable without changing the SDK's status-based recovery contract.
 * A brief Boat outage is retried once: any call whose request never arrived, and an
 * `idempotent` call that Boat failed on its side. A sandbox that took the request and did not
 * answer in time would only time out again, so that is never resent. A server error that
 * remains is an outage at Boat, reported as unresponsive like a connection Boat never answered.
 * So is Boat refusing to serve the operator's account until it is paid for: users can only wait.
 * Only idempotent calls are resent after a rate limit: create and command start have no
 * idempotency key and could duplicate billed sandboxes or command effects. Limits that clear
 * within a minute get one retry after the wait plus jitter, bounded by the caller's signal.
 * Cancellation during the wait or resend preserves Boat's refusal.
 */
export function wrapBoatCall<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
  apiKey: string,
  idempotent = false,
  gate?: BoatRequestGate,
  timeoutMs?: number,
): (...args: Args) => Promise<Result> {
  const attempt = async (...args: Args): Promise<Result> => {
    const signal = callerSignal(args[1]);
    await gate?.wait(signal);
    const limit = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    try {
      return await call(
        ...(limit ? withSignal(args, signal ? AbortSignal.any([signal, limit]) : limit) : args),
      );
    } catch (error) {
      if (limit?.aborted && !signal?.aborted) {
        throw new SandboxUnresponsiveError("Boat did not answer in time", { cause: error });
      }
      const { FetchError, ResponseError } = await boatSdk();
      // The connection to Boat failed without an answer. The request may have arrived, so it
      // is not resent unless it never left; background work tries again on its next pass.
      if (error instanceof FetchError && !aborted(error, callerSignal(args[1]))) {
        throw new SandboxUnresponsiveError("Boat could not be reached", { cause: error });
      }
      if (!(error instanceof BoatApiError || error instanceof ResponseError)) throw error;
      const wrapped =
        error instanceof BoatApiError ? error : await boatResponseError(error.response, apiKey);
      if (error.response.status === 429) {
        const { retryAfterMs } = wrapped;
        if (wrapped.code === BOAT_IP_RATE_LIMIT && retryAfterMs) gate?.close(retryAfterMs);
        throw new SandboxRateLimitError({ cause: wrapped, retryAfterMs });
      }
      // Boat's proxy reached the sandbox but gave up waiting for its answer.
      if (wrapped.code === "sandbox_direct_failed" && /\btimeout\b/i.test(wrapped.message)) {
        throw new SandboxUnresponsiveError(wrapped.message, { cause: wrapped });
      }
      // Boat has no room to start the machine now; a later start finds some.
      if (wrapped.code === "resume_failed" && /\bat capacity\b/i.test(wrapped.message)) {
        throw new SandboxUnavailableError({ cause: wrapped });
      }
      // Boat is still applying another change, such as a keep-alive; a later stop succeeds.
      if (wrapped.code === "stop_failed" && /\bis updating\b/i.test(wrapped.message)) {
        throw new SandboxUnresponsiveError(wrapped.message, { cause: wrapped });
      }
      throw wrapped;
    }
  };
  const attemptWithRetry = async (...args: Args): Promise<Result> => {
    const signal = callerSignal(args[1]);
    try {
      return await attempt(...args);
    } catch (error) {
      const wait = rateLimitWait(error);
      if (idempotent && signal && wait !== undefined) {
        // Preserve the rate-limit error if cancellation ends the wait or resend.
        try {
          await delay(spread(wait), undefined, { signal });
          return await attempt(...args);
        } catch (failure) {
          throw signal.aborted ? error : failure;
        }
      }
      if (!unsent(error) && !(idempotent && failedAtBoat(error))) throw error;
      await delay(BOAT_RETRY_DELAY_MS, undefined, { signal });
      return attempt(...args);
    }
  };
  return async (...args) => {
    try {
      return await attemptWithRetry(...args);
    } catch (error) {
      if (billingRequired(error)) throw new SandboxProviderAccountError({ cause: error });
      if (failedAtBoat(error)) throw new SandboxUnresponsiveError(error.message, { cause: error });
      throw error;
    }
  };
}

function withSignal<Args extends unknown[]>(args: Args, signal: AbortSignal): Args {
  const [request, init, ...rest] = args;
  return [request, { ...(init as RequestInit | undefined), signal }, ...rest] as unknown as Args;
}

/** The `RequestInit` signal the SDK takes as each operation's second argument. */
export function callerSignal(init: unknown): AbortSignal | undefined {
  const signal = (init as RequestInit | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * How long to wait before resending an idempotent request refused under the per-IP limit or
 * a start limit over the minute, when the wait ends within that minute. A quota over a longer
 * window only clears by sending less, so it is not resent.
 */
function rateLimitWait(error: unknown): number | undefined {
  const limit = error instanceof SandboxRateLimitError ? error.cause : undefined;
  if (!(limit instanceof BoatApiError) || limit.retryAfterMs === undefined) return undefined;
  const clearsWithinWindow =
    (limit.code === BOAT_IP_RATE_LIMIT || limit.window === "minute") &&
    limit.retryAfterMs <= BOAT_RATE_WINDOW_MS;
  return clearsWithinWindow ? limit.retryAfterMs : undefined;
}

/** A wait plus a random part of a second, so callers waiting together do not wake together. */
function spread(ms: number): number {
  return ms + Math.random() * BOAT_WAKE_SPREAD_MS;
}

/** True when neither Boat nor the sandbox received the request, so sending it again is safe. */
function unsent(error: unknown): boolean {
  // Boat's proxy could not open a connection to the sandbox machine.
  if (error instanceof BoatApiError) {
    return error.code === "sandbox_direct_failed" && /\bECONNREFUSED\b/.test(error.message);
  }
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && UNSENT_CODES.has(code)) return true;
    // Reset during the TLS handshake, before any of the request was written.
    if (code === "ECONNRESET" && /before secure TLS connection/.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** A fetch the caller cancelled or that ran out of time, rather than one the network lost. */
function aborted(error: FetchError, signal: AbortSignal | undefined): boolean {
  const name = error.cause instanceof Error ? error.cause.name : undefined;
  return signal?.aborted === true || name === "AbortError" || name === "TimeoutError";
}

function failedAtBoat(error: unknown): error is BoatApiError {
  return error instanceof BoatApiError && TRANSIENT_STATUSES.has(error.response.status);
}

function billingRequired(error: unknown): error is BoatApiError {
  return error instanceof BoatApiError && error.response.status === 402;
}

export async function boatResponseError(
  response: Response,
  apiKey: string,
  signal?: AbortSignal,
): Promise<BoatApiError> {
  const body = await readErrorBody(response, signal);
  const code = safeIdentifier(body?.code);
  const requestId = safeIdentifier(body?.requestId);
  const prefix = `Boat API request failed (HTTP ${response.status}${code ? `, ${code}` : ""})`;
  const detail =
    typeof body?.message === "string"
      ? redactSecrets(body.message, [apiKey])
          .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
          .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 512)
      : "";
  return new BoatApiError(
    response,
    redactSecrets(
      `${prefix}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`,
      [apiKey],
    ),
    code,
    response.status === 429 ? retryAfterMs(response, body) : undefined,
    safeIdentifier(body?.window),
  );
}

/**
 * The wait a 429 names: `retryAfter` seconds in the body or the `Retry-After` header on the
 * per-IP limit, or a start limit's `window` when that is the minute. Hour and day windows only
 * clear by starting less, so they name no wait.
 */
function retryAfterMs(
  response: Response,
  body: Record<string, unknown> | undefined,
): number | undefined {
  const header = response.headers.get("Retry-After")?.trim();
  const seconds =
    typeof body?.retryAfter === "number"
      ? body.retryAfter
      : header && /^\d+$/.test(header)
        ? Number(header)
        : header
          ? (Date.parse(header) - Date.now()) / 1_000
          : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds * 1_000), BOAT_MAX_RETRY_AFTER_MS);
  }
  return body?.code === BOAT_IP_RATE_LIMIT || body?.window === "minute"
    ? BOAT_RATE_WINDOW_MS
    : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}

async function readErrorBody(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const readSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(BOAT_ERROR_RESPONSE_TIMEOUT_MS)])
    : AbortSignal.timeout(BOAT_ERROR_RESPONSE_TIMEOUT_MS);
  try {
    const bytes = await readBodyCapped(response, MAX_BOAT_ERROR_RESPONSE_BYTES, readSignal);
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
