import { lookup } from "node:dns/promises";
import { MIMEType } from "node:util";
import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import { readBoundedResponseBytes } from "@rakazo/core";
import type { Dispatcher } from "undici";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { egressRefused } from "./network-address.js";
import { createCheckedProxyDispatcher } from "./proxy-dispatcher.js";
import { fetchPairedWithDispatcher } from "./undici-fetch.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo)";

export type { ResolveHostname } from "./network-address.js";

export interface SafeWebFetchOptions {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
  /** Keep the first `maxBytes` of a longer body instead of rejecting it. */
  truncate?: boolean;
  /** Refuse any hop, redirects included, whose port is not listed. */
  allowedPorts?: readonly number[];
  /**
   * Test seam for dispatcher teardown. Defaults to `dispatcher.close()`.
   * Always raced against the shared operation deadline.
   */
  cleanup?: () => Promise<void>;
  /**
   * Test seam for force-teardown after cleanup. Defaults to `dispatcher.destroy()`.
   * Invoked without awaiting so a hanging destroy cannot extend the deadline.
   * May return a Promise (`dispatcher.destroy()` does); rejections are swallowed.
   */
  destroy?: () => void | Promise<void>;
}

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export async function assertSafeWebUrl(
  value: string,
  resolve: ResolveHostname = defaultResolveHostname,
  signal?: AbortSignal,
  allowedPorts?: readonly number[],
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http: and https: URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URL must not contain credentials");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (allowedPorts && !allowedPorts.includes(port)) {
    throw new Error("URL port is not allowed");
  }
  await resolvePublicHost(url.hostname, resolve, signal);
  return url;
}

async function resolvePublicHost(
  host: string,
  resolve: ResolveHostname,
  signal?: AbortSignal,
): Promise<ResolvedAddress[]> {
  const hostname = host.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) {
    throw egressRefused(hostname, new Error("URL targets a private or internal host"));
  }
  const addresses = await withAbort(resolve(hostname), signal);
  try {
    assertPublicAddresses(addresses);
  } catch (error) {
    throw egressRefused(hostname, error);
  }
  return addresses;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (isInternalHostname(host) || isCloudMetadataHost(host)) return true;
  return ipVersion(host) !== 0 && isNonPublicAddress(host);
}

type SafeWebResponse<Body> = { url: string; body: Body; contentType: string | null };

export async function fetchSafeWebText(
  url: string,
  options: SafeWebFetchOptions = {},
): Promise<SafeWebResponse<string>> {
  const response = await fetchSafeWebBytes(url, options);
  let decoder = new TextDecoder();
  try {
    const charset =
      response.contentType && new MIMEType(response.contentType).params.get("charset");
    if (charset) decoder = new TextDecoder(charset);
  } catch {
    // Preserve UTF-8 decoding for malformed media types or unsupported charset labels.
  }
  return { ...response, body: decoder.decode(response.body) };
}

export async function fetchSafeWebBytes(
  url: string,
  options: SafeWebFetchOptions = {},
): Promise<SafeWebResponse<Uint8Array>> {
  return withSafeEgress(options, ({ baseFetch, resolve, dispatcher, signal }) =>
    followRedirects(url, {
      baseFetch,
      resolve,
      dispatcher,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      headers: options.headers,
      signal,
      redirectsRemaining: options.maxRedirects ?? MAX_REDIRECTS,
      truncate: options.truncate ?? false,
      allowedPorts: options.allowedPorts,
    }),
  );
}

export interface SafeHttpResponse {
  url: string;
  status: number;
  headers: Headers;
  /** At most `maxBytes`; `truncated` when the body went on. */
  body: Uint8Array;
  truncated: boolean;
}

/**
 * One request with any method. A redirect is returned, never followed, so a body or payment
 * is only ever sent to the URL it was meant for.
 */
export async function fetchSafeHttpRequest(
  url: string,
  request: { method: string; headers?: Record<string, string>; body?: string },
  options: Omit<SafeWebFetchOptions, "headers" | "maxRedirects" | "truncate"> = {},
): Promise<SafeHttpResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return withSafeEgress(options, async ({ baseFetch, resolve, dispatcher, signal }) => {
    const validated = await assertSafeWebUrl(url, resolve, signal, options.allowedPorts);
    const response = await withAbort(
      baseFetch(validated.href, {
        method: request.method,
        redirect: "manual",
        signal,
        headers: { "user-agent": options.userAgent ?? DEFAULT_USER_AGENT, ...request.headers },
        ...(request.body !== undefined ? { body: request.body } : {}),
        dispatcher,
      } as RequestInit & { dispatcher: Dispatcher }),
      signal,
    );
    const body = await readBodyPrefix(response, maxBytes + 1, signal);
    return {
      url: validated.href,
      status: response.status,
      headers: response.headers,
      body: body.slice(0, maxBytes),
      truncated: body.byteLength > maxBytes,
    };
  });
}

async function withSafeEgress<T>(
  options: SafeWebFetchOptions,
  run: (egress: {
    baseFetch: typeof globalThis.fetch;
    resolve: ResolveHostname;
    dispatcher: Dispatcher;
    signal: AbortSignal;
  }) => Promise<T>,
): Promise<T> {
  const resolve = options.resolveHostname ?? defaultResolveHostname;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseFetch = fetchPairedWithDispatcher(options.fetch);
  const dispatcher = createCheckedProxyDispatcher(resolve, (addresses, hostname) => {
    if (isBlockedHostname(hostname)) throw new Error("URL targets a private or internal host");
    assertPublicAddresses(addresses);
  });
  // One deadline for the whole redirect chain + body read + cleanup, not per hop.
  const signal = combineSignals(options.signal, AbortSignal.timeout(timeoutMs));
  const cleanup =
    options.cleanup ??
    (() =>
      dispatcher.close().then(
        () => undefined,
        () => undefined,
      ));
  const destroy = options.destroy ?? (() => dispatcher.destroy());

  try {
    return await run({ baseFetch, resolve, dispatcher, signal });
  } finally {
    // Race graceful close against the shared deadline. Do not wait unbounded on close().
    await withAbort(cleanup(), signal).catch(() => undefined);
    // If the deadline aborted (close hung or already timed out), force-destroy
    // without awaiting so sockets/FDs cannot leak past the timeout.
    // Agent.destroy() returns a Promise — swallow async rejection (sync try/catch cannot).
    if (signal.aborted) {
      try {
        void Promise.resolve(destroy()).catch(() => undefined);
      } catch {
        // sync throw from destroy seam
      }
    }
  }
}

async function followRedirects(
  rawUrl: string,
  state: {
    baseFetch: typeof globalThis.fetch;
    resolve: ResolveHostname;
    dispatcher: Dispatcher;
    maxBytes: number;
    userAgent: string;
    headers?: Record<string, string>;
    signal: AbortSignal;
    redirectsRemaining: number;
    truncate: boolean;
    allowedPorts?: readonly number[];
  },
): Promise<SafeWebResponse<Uint8Array>> {
  if (state.signal.aborted) {
    throw abortError(state.signal);
  }
  const validated = await assertSafeWebUrl(rawUrl, state.resolve, state.signal, state.allowedPorts);
  // Race fetch against the deadline — injected fetch may ignore init.signal.
  const response = await withAbort(
    state.baseFetch(validated.href, {
      method: "GET",
      redirect: "manual",
      signal: state.signal,
      headers: {
        "user-agent": state.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        ...state.headers,
      },
      dispatcher: state.dispatcher,
    } as RequestInit & { dispatcher: Dispatcher }),
    state.signal,
  );

  if (response.status >= 300 && response.status < 400) {
    if (state.redirectsRemaining <= 0) {
      await cancelResponseBody(response, state.signal);
      throw new Error("Too many redirects");
    }
    const location = response.headers.get("location");
    if (!location) {
      await cancelResponseBody(response, state.signal);
      throw new Error("Redirect missing Location header");
    }
    const next = new URL(location, validated.href);
    const headers = next.origin === validated.origin ? state.headers : undefined;
    // Release this hop before following — do not leave the body open across recursion.
    await cancelResponseBody(response, state.signal);
    return followRedirects(next.href, {
      ...state,
      headers,
      redirectsRemaining: state.redirectsRemaining - 1,
    });
  }

  if (!response.ok) {
    await cancelResponseBody(response, state.signal);
    throw new Error(`Request failed: HTTP ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  if (!state.truncate && contentLength && Number(contentLength) > state.maxBytes) {
    await cancelResponseBody(response, state.signal);
    throw new Error("Response is too large");
  }

  const body = state.truncate
    ? await readBodyPrefix(response, state.maxBytes, state.signal)
    : await readBodyCapped(response, state.maxBytes, state.signal);

  return { url: validated.href, body, contentType: response.headers.get("content-type") };
}

async function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  const cancel = response.body?.cancel() ?? Promise.resolve();
  // A hanging cancel must not outlive the shared deadline.
  await withAbort(
    cancel.catch(() => undefined),
    signal,
  ).catch(() => undefined);
}

/** Read the body as a stream and abort once maxBytes is exceeded (DoS guard). */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return readBoundedResponseBytes(response, {
    maxBytes,
    tooLargeMessage: "Response is too large",
    read: (operation) => {
      if (response.body && signal?.aborted) throw abortError(signal);
      return withAbort(operation(), signal);
    },
  });
}

/** Read at most maxBytes and release the rest of the stream unread. */
async function readBodyPrefix(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await withAbort(response.arrayBuffer(), signal);
    return new Uint8Array(buffer).slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const prefix = new Uint8Array(maxBytes);
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      const take = Math.min(value.byteLength, maxBytes - total);
      prefix.set(value.subarray(0, take), total);
      total += take;
    }
  } finally {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  }
  return prefix.slice(0, total);
}

function assertPublicAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0 || addresses.some((entry) => isNonPublicAddress(entry.address))) {
    throw new Error("URL resolves to a private address");
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request timed out");
}

/** Race a promise against an AbortSignal so stalled work cannot outlive the deadline. */
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  return AbortSignal.any(active);
}
