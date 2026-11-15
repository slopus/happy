import { lookup } from "node:dns/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ipVersion,
  isCloudMetadataAddress,
  isLocalhostOrLoopbackIp,
  isNonPublicAddress,
} from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";
import { Agent } from "undici";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { createMcpClient } from "./mcp-output-schema.js";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { createAddressCheckedLookup } from "./network-address.js";
import type { RemoteTransportDependencies, SafeRemoteFetch } from "./remote-mcp.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";
import { fetchPairedWithDispatcher } from "./undici-fetch.js";
import { isBlockedHostname } from "./web-ssrf.js";

const SERENITY_TIMEOUT_MS = 15_000;
const SERENITY_TERMINATE_TIMEOUT_MS = 2_000;
export const MAX_SERENITY_FACT_CHARS = 10_000;
/** Hosted Serenity rejects larger facts; self-hosted brains share the same bound. */
export const MAX_SERENITY_FACT_BYTES = 4096;
export const MAX_SERENITY_PROVENANCE_CHARS = 500;
/** The most facts one recall returns. */
const MAX_SERENITY_RECALL_LIMIT = 100;

export type SerenityNetworkDependencies = RemoteTransportDependencies;

export interface SerenityConnectionConfig {
  endpoint: string;
  token: string;
  /** Set when prepare classifies the endpoint as private LAN/DNS. */
  endpointTrust?: "private" | "public";
}

export type SerenityResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SerenityRecallFact {
  factId: string;
  fact: string;
  provenance: string;
  kind?: string;
  entitySlug?: string | null;
}

export interface SerenityRememberResult {
  id: string;
  status: string;
  statusText?: string;
}

export interface SerenityForgetResult {
  id: string;
  expired: boolean;
  reason: string | null;
}

/** Endpoints are route prefixes: no credentials, query, or fragment. There is no default URL. */
export function parseSerenityEndpoint(endpoint: string): URL {
  if (!endpoint.trim()) throw new Error("Serenity endpoint is required.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Serenity endpoint must be a valid HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error(
      "Serenity endpoint must use HTTP(S) without credentials, a query, or a fragment.",
    );
  }
  return url;
}

export function normalizeSerenityEndpoint(endpoint: string): string {
  return normalizeSerenityEndpointUrl(endpoint).href.replace(/\/+$/, "");
}

function normalizeSerenityEndpointUrl(endpoint: string): URL {
  const url = parseSerenityEndpoint(endpoint);
  assertAllowedSerenityEndpoint(url);
  const path = url.pathname.replace(/\/+$/, "") || "";
  url.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return url;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Loopback, RFC1918/ULA literals, or HTTP need deployment-owner authorization. */
export function serenityEndpointRequiresPrivateEndpoint(endpoint: string): boolean {
  const url = parseSerenityEndpoint(endpoint);
  const host = hostnameOf(url);
  if (isLocalhostOrLoopbackIp(host) || isBlockedHostname(host)) return true;
  if (ipVersion(host) !== 0) return isNonPublicAddress(host);
  // Unresolved public-looking hostnames may still be LAN DNS over HTTP.
  return url.protocol === "http:";
}

/**
 * Classifies endpoint trust for fetch + owner gating. Public-looking HTTPS names
 * that resolve only to private addresses are treated as private LAN endpoints.
 */
export async function classifySerenityEndpointTrust(
  endpoint: string,
  resolveHostname?: ResolveHostname,
): Promise<"private" | "public"> {
  const url = parseSerenityEndpoint(endpoint);
  if (serenityEndpointRequiresPrivateEndpoint(url.href)) return "private";
  const host = hostnameOf(url);
  const resolve =
    resolveHostname ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const addresses = await resolve(host);
  if (addresses.length === 0) {
    throw new Error("Serenity endpoint did not resolve to an address.");
  }
  if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
    throw new Error("Serenity endpoint targets a blocked address.");
  }
  if (addresses.some((entry) => isNonPublicAddress(entry.address))) return "private";
  return "public";
}

function assertAllowedSerenityEndpoint(url: URL): void {
  const host = hostnameOf(url);
  if (isCloudMetadataAddress(host)) {
    throw new Error("Serenity endpoint targets a blocked address.");
  }
  if (url.protocol === "http:") {
    // Bearer tokens stay on the wire; only loopback may use cleartext HTTP.
    if (!isLocalhostOrLoopbackIp(host)) {
      throw new Error(
        "Serenity HTTP endpoints are limited to loopback (localhost / 127.0.0.1 / ::1); use HTTPS for LAN or public hosts.",
      );
    }
    return;
  }
}

function mcpTextPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const row = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  };
  if (row.structuredContent && typeof row.structuredContent === "object") {
    return row.structuredContent;
  }
  const content = row.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const entry = part as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") {
      try {
        return JSON.parse(entry.text) as unknown;
      } catch {
        return entry.text;
      }
    }
  }
  return undefined;
}

function toolCallIsError(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError);
}

function verbErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const row = payload as {
    error?: unknown;
    message?: unknown;
    suggestion?: unknown;
    reset_at?: unknown;
  };
  const message = typeof row.message === "string" ? row.message : null;
  const code = typeof row.error === "string" && row.error !== message ? `(${row.error})` : null;
  const parts = [
    message,
    code,
    typeof row.suggestion === "string" ? row.suggestion : null,
    typeof row.reset_at === "string" ? `Resets at ${row.reset_at}.` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : fallback;
}

/** Surface hosted gateway rate limits plainly instead of as an opaque transport error. */
function assertNotRateLimited(response: Response): Response {
  if (response.status !== 429) return response;
  cancelResponseBody(response);
  const retryAfter = response.headers.get("retry-after")?.trim();
  // Retry-After is either delta-seconds or an HTTP date.
  const when = !retryAfter ? null : /^\d+$/.test(retryAfter) ? `${retryAfter}s` : retryAfter;
  throw new Error(
    when
      ? `Serenity rate limit reached; retry after ${when}.`
      : "Serenity rate limit reached; retry shortly.",
  );
}

/**
 * Owner-gated private endpoints: IP literals use plain fetch; hostnames pin DNS
 * to private non-metadata addresses so persisted endpointTrust cannot rebind to
 * IMDS. Public HTTPS uses createSafeRemoteFetch (public-only pin).
 */
function serenityFetchPath(
  config: SerenityConnectionConfig,
  url: URL,
): "private-literal" | "private-dns" | "public" {
  if (config.endpointTrust === "private" || serenityEndpointRequiresPrivateEndpoint(url.href)) {
    return ipVersion(hostnameOf(url)) !== 0 ? "private-literal" : "private-dns";
  }
  return "public";
}

function defaultResolveHostname(): ResolveHostname {
  return (hostname: string) => lookup(hostname, { all: true, verbatim: true });
}

function assertPrivateLanAddresses(addresses: ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new Error("Serenity endpoint did not resolve to an address.");
  }
  if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
    throw new Error("Serenity endpoint targets a blocked address.");
  }
  if (addresses.some((entry) => !isNonPublicAddress(entry.address))) {
    throw new Error("Serenity endpoint no longer resolves to a private address.");
  }
}

/**
 * Pin owner-gated hostname fetches to one private LAN answer set for the request.
 * Resolve once, then reuse those addresses in the dispatcher lookup so a second DNS
 * answer cannot redirect the bearer token to a different internal host.
 */
export function createSerenityPrivateLanFetch(
  baseFetch?: typeof globalThis.fetch,
  resolve: ResolveHostname = defaultResolveHostname(),
): SafeRemoteFetch {
  const transport = fetchPairedWithDispatcher(baseFetch);
  const privateFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("Serenity fetch requires a URL, not a Request");
    }
    const url = new URL(String(input));
    const pinned = await resolve(hostnameOf(url));
    assertPrivateLanAddresses(pinned);
    const dispatcher = new Agent({
      connect: {
        lookup: createAddressCheckedLookup(async () => pinned, assertPrivateLanAddresses),
      },
    });
    try {
      const response = await transport(url, {
        ...init,
        redirect: "manual",
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (response.status >= 300 && response.status < 400) {
        cancelResponseBody(response);
        throw new Error("Serenity MCP redirects are not permitted; configure the final URL.");
      }
      // The dispatcher must be able to close before the caller can inspect the response.
      if (response.status === 429) cancelResponseBody(response);
      return response;
    } catch (error) {
      throw new Error(
        `Could not reach ${url.host}${error instanceof Error ? `: ${error.message}` : ""}`,
        { cause: error },
      );
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  };
  const result = privateFetch as SafeRemoteFetch;
  result.close = async () => undefined;
  return result;
}

async function withSerenityClient<T>(
  config: SerenityConnectionConfig,
  signal: AbortSignal | undefined,
  run: (client: Client, signal: AbortSignal) => Promise<T>,
  network: SerenityNetworkDependencies = {},
): Promise<T> {
  const url = normalizeSerenityEndpointUrl(config.endpoint);
  const requestSignal = combineSignals(signal, AbortSignal.timeout(SERENITY_TIMEOUT_MS));
  const path = serenityFetchPath(config, url);
  const resolve = network.resolveHostname ?? defaultResolveHostname();
  const pinnedFetch: SafeRemoteFetch | null =
    path === "public"
      ? createSafeRemoteFetch(network.fetch, network.resolveHostname)
      : path === "private-dns"
        ? createSerenityPrivateLanFetch(network.fetch, resolve)
        : null;
  const localFetch = network.fetch ?? globalThis.fetch;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json, text/event-stream",
      },
      redirect: "manual",
      signal: requestSignal,
    },
    fetch: async (input, init) => {
      if (pinnedFetch) return assertNotRateLimited(await pinnedFetch(input, init));
      const response = await localFetch(input, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        cancelResponseBody(response);
        throw new Error("Serenity MCP redirects are not permitted; configure the final URL.");
      }
      return assertNotRateLimited(response);
    },
  });
  const client = createMcpClient({ name: "rakazo", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { signal: requestSignal, timeout: SERENITY_TIMEOUT_MS });
    // A server or proxy may echo the bearer token it received; never hand it to the model.
    return redactConnectorPayload(await run(client, requestSignal), [config.token]) as T;
  } finally {
    // Each verb opens its own MCP session; end it server-side instead of leaving it to expire.
    // The SDK's DELETE ignores our request signal, so bound it before closing.
    if (transport.sessionId) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        transport.terminateSession().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SERENITY_TERMINATE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    await client.close().catch(() => undefined);
    await pinnedFetch?.close().catch(() => undefined);
  }
}

export async function probeSerenity(
  config: SerenityConnectionConfig,
  signal?: AbortSignal,
  network?: SerenityNetworkDependencies,
  options: { requireWrites?: boolean } = {},
): Promise<SerenityResult<void>> {
  try {
    await withSerenityClient(
      config,
      signal,
      async (client, requestSignal) => {
        const listed = await client.listTools(
          {},
          { signal: requestSignal, timeout: SERENITY_TIMEOUT_MS },
        );
        const names = new Set(listed.tools.map((tool) => tool.name));
        const required =
          options.requireWrites === true
            ? (["recall", "remember", "forget"] as const)
            : (["recall"] as const);
        for (const tool of required) {
          if (!names.has(tool)) {
            throw new Error(`Serenity MCP is missing the "${tool}" tool.`);
          }
        }
      },
      network,
    );
    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity is unreachable: ${sanitizeConnectorError(error, [config.token])}`,
    };
  }
}

/**
 * Lists an entity's newest facts, up to the server maximum. Recall's `query` only drives a
 * separate page search; facts are filtered by entity and sorted newest first regardless of it,
 * so the query is omitted and callers rank the facts themselves.
 */
export async function recallSerenity(
  config: SerenityConnectionConfig,
  options: {
    entity?: string;
    signal?: AbortSignal;
    network?: SerenityNetworkDependencies;
  } = {},
): Promise<SerenityResult<SerenityRecallFact[]>> {
  try {
    const payload = await withSerenityClient(
      config,
      options.signal,
      async (client, signal) => {
        const result = await client.callTool(
          {
            name: "recall",
            arguments: {
              limit: MAX_SERENITY_RECALL_LIMIT,
              ...(options.entity ? { entity: options.entity } : {}),
            },
          },
          undefined,
          { signal, timeout: SERENITY_TIMEOUT_MS },
        );
        const body = mcpTextPayload(result);
        if (toolCallIsError(result)) {
          throw new Error(verbErrorMessage(body, "Serenity recall failed"));
        }
        return body;
      },
      options.network,
    );
    return { ok: true, value: parseRecallFacts(payload) };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity recall failed: ${sanitizeConnectorError(error, [config.token])}`,
    };
  }
}

export async function rememberSerenity(
  fact: string,
  provenance: string,
  config: SerenityConnectionConfig,
  options: {
    entity?: string;
    /** Serenity replays the same fact for a repeated key instead of writing a duplicate. */
    operationKey?: string;
    signal?: AbortSignal;
    network?: SerenityNetworkDependencies;
  } = {},
): Promise<SerenityResult<SerenityRememberResult>> {
  const trimmedFact = fact.trim();
  const trimmedProvenance = provenance.trim().slice(0, MAX_SERENITY_PROVENANCE_CHARS);
  if (!trimmedFact) return { ok: false, error: "fact is required" };
  if (Buffer.byteLength(trimmedFact, "utf8") > MAX_SERENITY_FACT_BYTES) {
    return {
      ok: false,
      error: `fact exceeds ${MAX_SERENITY_FACT_BYTES} bytes; save a shorter fact`,
    };
  }
  if (!trimmedProvenance) return { ok: false, error: "provenance is required" };
  try {
    const payload = await withSerenityClient(
      config,
      options.signal,
      async (client, signal) => {
        const result = await client.callTool(
          {
            name: "remember",
            arguments: {
              fact: trimmedFact,
              provenance: trimmedProvenance,
              ...(options.entity ? { entity: options.entity } : {}),
              ...(options.operationKey ? { operation_key: options.operationKey } : {}),
            },
          },
          undefined,
          { signal, timeout: SERENITY_TIMEOUT_MS },
        );
        const body = mcpTextPayload(result);
        if (toolCallIsError(result)) {
          throw new Error(verbErrorMessage(body, "Serenity remember failed"));
        }
        return body;
      },
      options.network,
    );
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Serenity remember returned an unexpected payload" };
    }
    const row = payload as { id?: unknown; status?: unknown; status_text?: unknown };
    if (typeof row.id !== "string" || typeof row.status !== "string") {
      return { ok: false, error: "Serenity remember returned an unexpected payload" };
    }
    return {
      ok: true,
      value: {
        id: row.id,
        status: row.status,
        ...(typeof row.status_text === "string" ? { statusText: row.status_text } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity remember failed: ${sanitizeConnectorError(error, [config.token])}`,
    };
  }
}

export async function forgetSerenity(
  id: string,
  config: SerenityConnectionConfig,
  options: {
    reason?: string;
    signal?: AbortSignal;
    network?: SerenityNetworkDependencies;
  } = {},
): Promise<SerenityResult<SerenityForgetResult>> {
  const factId = id.trim();
  if (!factId) return { ok: false, error: "id is required" };
  try {
    const payload = await withSerenityClient(
      config,
      options.signal,
      async (client, signal) => {
        const result = await client.callTool(
          {
            name: "forget",
            // MEMORY_VERBS forget accepts only id + optional reason (additionalProperties: false).
            arguments: {
              id: factId,
              ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
            },
          },
          undefined,
          { signal, timeout: SERENITY_TIMEOUT_MS },
        );
        const body = mcpTextPayload(result);
        if (toolCallIsError(result)) {
          throw new Error(verbErrorMessage(body, "Serenity forget failed"));
        }
        return body;
      },
      options.network,
    );
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Serenity forget returned an unexpected payload" };
    }
    const row = payload as { id?: unknown; expired?: unknown; reason?: unknown };
    if (typeof row.id !== "string" || typeof row.expired !== "boolean") {
      return { ok: false, error: "Serenity forget returned an unexpected payload" };
    }
    return {
      ok: true,
      value: {
        id: row.id,
        expired: row.expired,
        reason: typeof row.reason === "string" ? row.reason : null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Serenity forget failed: ${sanitizeConnectorError(error, [config.token])}`,
    };
  }
}

function parseRecallFacts(payload: unknown): SerenityRecallFact[] {
  if (!payload || typeof payload !== "object") return [];
  const facts = (payload as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];
  const parsed: SerenityRecallFact[] = [];
  for (const item of facts) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      fact_id?: unknown;
      fact?: unknown;
      provenance?: unknown;
      kind?: unknown;
      entity_slug?: unknown;
    };
    const fact =
      typeof row.fact === "string" ? row.fact.trim().slice(0, MAX_SERENITY_FACT_CHARS) : "";
    const factId = typeof row.fact_id === "string" ? row.fact_id : "";
    const provenance =
      typeof row.provenance === "string"
        ? row.provenance.trim().slice(0, MAX_SERENITY_PROVENANCE_CHARS)
        : "";
    if (!fact || !factId) continue;
    parsed.push({
      factId,
      fact,
      provenance,
      ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
      ...(row.entity_slug === null || typeof row.entity_slug === "string"
        ? { entitySlug: row.entity_slug }
        : {}),
    });
  }
  return parsed;
}
