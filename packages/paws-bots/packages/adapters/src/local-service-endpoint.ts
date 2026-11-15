import { lookup } from "node:dns/promises";
import {
  ipVersion,
  isCloudMetadataAddress,
  isCloudMetadataHost,
  isLinkLocalAddress,
  isLocalhostOrLoopbackIp,
  isNonPublicAddress,
  normalizeHost,
} from "@rakazo/contracts";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { egressRefused } from "./network-address.js";
import { createPrivateNetworkFetch, isPrivateRemoteMcpHostname } from "./remote-mcp.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";
import { withAbort } from "./web-ssrf.js";

/**
 * Self-hosted ("local") memory services: a loopback or private-network endpoint the
 * server operator runs. Hostnames are resolved once, checked, and pinned for requests.
 */

const LOCAL_NETWORK_ERROR = "Local mode requires a loopback or private-network address.";
const BLOCKED_TARGET_ERROR = "Local mode cannot target a blocked address.";
const LOCAL_DNS_TIMEOUT_MS = 10_000;

export interface LocalServiceConnection {
  baseUrl: string;
  /** Test seam. Production resolves private DNS and pins the private answers. */
  resolveHostname?: ResolveHostname;
  /**
   * Private addresses already accepted for this host. The transport checks them
   * again at request time and does not resolve the name.
   */
  pinnedAddresses?: ResolvedAddress[];
  /** Test seam. Production uses the runtime fetch paired with the private-host dispatcher. */
  fetch?: typeof globalThis.fetch;
}

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Base URLs are route prefixes, never credentials or request query/fragment state. */
export function parseServiceBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    // search/hash are empty for a bare ?/#, but those delimiters still swallow appended routes.
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error(
      "Memory base URL must use HTTP(S) without credentials, a query, or a fragment.",
    );
  }
  return url;
}

function hostnameOf(url: URL): string {
  return normalizeHost(url.hostname);
}

function isBlockedHost(host: string): boolean {
  return isCloudMetadataHost(host) || (ipVersion(host) !== 0 && isLinkLocalAddress(host));
}

function assertPrivateLanAddresses(addresses: ResolvedAddress[]): void {
  if (
    addresses.some(
      (entry) => isCloudMetadataAddress(entry.address) || isLinkLocalAddress(entry.address),
    )
  ) {
    throw new Error(BLOCKED_TARGET_ERROR);
  }
  if (addresses.length === 0 || addresses.some((entry) => !isNonPublicAddress(entry.address))) {
    throw new Error(LOCAL_NETWORK_ERROR);
  }
}

/** Literals and metadata names. Hostnames are classified by pinLocalServiceHost. */
export function assertLocalServiceBaseUrlSync(baseUrl: string): void {
  const host = hostnameOf(parseServiceBaseUrl(baseUrl));
  if (isBlockedHost(host)) throw egressRefused(host, new Error(BLOCKED_TARGET_ERROR));
  if (isLocalhostOrLoopbackIp(host) || isPrivateRemoteMcpHostname(host)) return;
  if (ipVersion(host) !== 0) throw egressRefused(host, new Error(LOCAL_NETWORK_ERROR));
}

/**
 * Local mode accepts loopback or a private-network host (Compose DNS, RFC1918, LAN suffixes).
 * Public hosts stay rejected. Private hosts require operator authorization.
 * Returns the pinned addresses for a hostname, or undefined when the host needs no DNS pin.
 */
export async function pinLocalServiceHost(
  baseUrl: string,
  options: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    signal?: AbortSignal;
  } = {},
): Promise<ResolvedAddress[] | undefined> {
  assertLocalServiceBaseUrlSync(baseUrl);
  const host = hostnameOf(parseServiceBaseUrl(baseUrl));
  if (isLocalhostOrLoopbackIp(host)) return undefined;
  if (options.allowPrivateEndpoint !== true) {
    throw egressRefused(host, new MemoryProviderPrivateEndpointRequiredError());
  }
  if (ipVersion(host) !== 0) return undefined;
  const resolve = options.resolveHostname ?? defaultResolveHostname;
  let addresses: ResolvedAddress[];
  try {
    addresses = await withAbort(
      resolve(host),
      options.signal ?? AbortSignal.timeout(LOCAL_DNS_TIMEOUT_MS),
    );
  } catch {
    throw new Error(LOCAL_NETWORK_ERROR);
  }
  try {
    assertPrivateLanAddresses(addresses);
  } catch (error) {
    throw egressRefused(host, error);
  }
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

export async function assertLocalServiceBaseUrl(
  baseUrl: string,
  options: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
  } = {},
): Promise<void> {
  await pinLocalServiceHost(baseUrl, options);
}

/** Recheck a persisted local endpoint before its credentials are decrypted. */
export async function revalidateLocalServiceSettings(
  settings: Record<string, string>,
): Promise<void> {
  if (settings.mode !== "local") return;
  if (!settings.baseUrl) throw new Error("baseUrl is required");
  await assertLocalServiceBaseUrl(settings.baseUrl, { allowPrivateEndpoint: true });
}

/** Loopback and IP literals have no DNS to rebind. Private names pin to private addresses. */
function pinsPrivateDns(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = hostnameOf(url);
  return !isLocalhostOrLoopbackIp(host) && ipVersion(host) === 0;
}

function resolverFor(connection: LocalServiceConnection): ResolveHostname {
  if (!connection.pinnedAddresses) return connection.resolveHostname ?? defaultResolveHostname;
  const addresses = connection.pinnedAddresses;
  return async () => addresses;
}

/** Fetch a local service, pinning private hostnames to their checked addresses. */
export async function fetchLocalService(
  connection: LocalServiceConnection,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const transport = connection.fetch ?? fetch;
  if (!pinsPrivateDns(connection.baseUrl)) return transport(url, init);
  const safe = createPrivateNetworkFetch(transport, resolverFor(connection));
  try {
    const response = await safe(url, init);
    // Closing the pinned dispatcher waits until its response body settles.
    // Hand the body to the caller first, and close when they read or cancel it.
    return releaseTransportWithBody(response, () => safe.close());
  } catch (error) {
    await safe.close().catch(() => undefined);
    throw error;
  }
}

function releaseTransportWithBody(response: Response, close: () => Promise<void>): Response {
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    void close().catch(() => undefined);
  };
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Checks a provider's local host once, then reuses its pinned addresses for every request. */
export class LocalServiceHost {
  private pinnedAddresses?: ResolvedAddress[];
  private hostReady = false;
  private pinTask?: Promise<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly resolveHostname?: ResolveHostname,
  ) {}

  /** Returns why the host is unusable, or null once it has been checked. */
  async block(signal?: AbortSignal): Promise<string | null> {
    // One successful check per provider. Repeating it would let a DNS blip block
    // a host this provider already reached, and multi-request recall would redo it.
    if (this.hostReady) return null;
    this.pinTask ??= this.resolvePin();
    try {
      await withAbort(this.pinTask, signal);
      this.hostReady = true;
      return null;
    } catch (error) {
      // Caller cancellation must not discard a still-bounded pin shared by other requests.
      if (!signal?.aborted) this.pinTask = undefined;
      return error instanceof Error ? error.message : BLOCKED_TARGET_ERROR;
    }
  }

  private async resolvePin(): Promise<void> {
    const pinned = await pinLocalServiceHost(this.baseUrl, {
      allowPrivateEndpoint: true,
      resolveHostname: this.resolveHostname,
    });
    if (pinned) this.pinnedAddresses = pinned;
  }

  withPin<T extends LocalServiceConnection>(connection: T): T {
    if (!this.pinnedAddresses) return connection;
    return { ...connection, pinnedAddresses: this.pinnedAddresses };
  }
}
