import type { LocalServiceConnection } from "./local-service-endpoint.js";
import { fetchLocalService, parseServiceBaseUrl } from "./local-service-endpoint.js";
import { readBodyCapped } from "./web-ssrf.js";

const SUPERMEMORY_TIMEOUT_MS = 15_000;
export const SUPERMEMORY_CLOUD_BASE_URL = "https://api.supermemory.ai";

/** Search responses contain at most five bounded memories plus small metadata. */
export const MAX_SUPERMEMORY_RESPONSE_BYTES = 1024 * 1024;

/** How many recalled memories a search asks for, and the most that are ever injected into a run. */
export const MAX_RECALLED_MEMORIES = 5;

/** Supermemory rejects memory content longer than this. */
export const MAX_MEMORY_CONTENT_CHARS = 10_000;

export interface SupermemoryResult {
  memory: string;
  similarity: number;
  updatedAt?: string;
}

export type SupermemorySearchResponse =
  | { ok: true; results: SupermemoryResult[] }
  | { ok: false; error: string };

export type SupermemorySaveResponse = { ok: true } | { ok: false; error: string };
export type SupermemoryProbeResponse = { ok: true } | { ok: false; error: string };

export interface SupermemoryConnectionConfig extends LocalServiceConnection {
  apiKey: string;
}

function requestUrl(baseUrl: string, path: string): string {
  const url = parseServiceBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url.href;
}

function isSupermemoryCloud(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === new URL(SUPERMEMORY_CLOUD_BASE_URL).origin;
  } catch {
    return false;
  }
}

async function fetchSupermemory(
  config: SupermemoryConnectionConfig,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (isSupermemoryCloud(config.baseUrl)) return (config.fetch ?? fetch)(url, init);
  return fetchLocalService(config, url, init);
}

async function releaseUnreadBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function boundedRecallLimit(limit: number): number {
  return Math.min(Math.max(1, Math.floor(limit)), MAX_RECALLED_MEMORIES);
}

function unreachableError(error: unknown): string {
  return `Supermemory is unreachable: ${error instanceof Error ? error.message : String(error)}`;
}

function authHeaders(config: SupermemoryConnectionConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

function parseSearchResults(data: unknown): SupermemoryResult[] {
  if (!data || typeof data !== "object") return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const parsed: SupermemoryResult[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      memory?: unknown;
      chunk?: unknown;
      similarity?: unknown;
      updatedAt?: unknown;
    };
    const text =
      typeof row.memory === "string" ? row.memory : typeof row.chunk === "string" ? row.chunk : "";
    const memory = text.trim().slice(0, MAX_MEMORY_CONTENT_CHARS);
    if (!memory) continue;
    parsed.push({
      memory,
      similarity: typeof row.similarity === "number" ? row.similarity : 0,
      ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    });
  }
  return parsed;
}

export async function searchSupermemory(
  query: string,
  containerTag: string,
  config: SupermemoryConnectionConfig,
  limit = MAX_RECALLED_MEMORIES,
  signal?: AbortSignal,
): Promise<SupermemorySearchResponse> {
  try {
    const requestAbort = requestSignal(signal);
    const response = await fetchSupermemory(config, requestUrl(config.baseUrl, "/v4/search"), {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({
        q: query,
        containerTag,
        searchMode: "memories",
        limit: boundedRecallLimit(limit),
      }),
      redirect: "error",
      signal: requestAbort,
    });
    if (!response.ok) {
      await releaseUnreadBody(response);
      return { ok: false, error: `Supermemory search failed: ${response.status}` };
    }
    return {
      ok: true,
      results: parseSearchResults(await readSupermemoryJson(response, requestAbort)),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Supermemory response is too large.") {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: unreachableError(error) };
  }
}

async function readSupermemoryJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SUPERMEMORY_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Supermemory response is too large.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(response, MAX_SUPERMEMORY_RESPONSE_BYTES, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Supermemory response is too large.");
    }
    throw error;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function searchSupermemoryContainers(
  query: string,
  containerTags: string[],
  config: SupermemoryConnectionConfig,
  limit = MAX_RECALLED_MEMORIES,
  signal?: AbortSignal,
): Promise<SupermemorySearchResponse> {
  const boundedLimit = boundedRecallLimit(limit);
  const responses = await Promise.all(
    containerTags.map((containerTag) =>
      searchSupermemory(query, containerTag, config, boundedLimit, signal),
    ),
  );
  const successful = responses.filter(
    (response): response is Extract<SupermemorySearchResponse, { ok: true }> => response.ok,
  );
  if (successful.length === 0) {
    return {
      ok: false,
      error: responses
        .filter(
          (response): response is Extract<SupermemorySearchResponse, { ok: false }> => !response.ok,
        )
        .map((response) => response.error)
        .join("; "),
    };
  }
  const byMemory = new Map<string, SupermemoryResult>();
  for (const result of successful.flatMap((response) => response.results)) {
    const existing = byMemory.get(result.memory);
    if (!existing || result.similarity > existing.similarity) byMemory.set(result.memory, result);
  }
  return {
    ok: true,
    results: [...byMemory.values()]
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, boundedLimit),
  };
}

export const SUPERMEMORY_DELETE_FORBIDDEN_ERROR =
  "Supermemory needs an owner or admin API key to delete memory from cleared conversations.";

/**
 * Deletes every memory in a container, e.g. after the conversation they summarize is cleared.
 * A missing container has nothing to delete.
 */
export async function deleteSupermemoryContainer(
  containerTag: string,
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SupermemorySaveResponse> {
  try {
    const response = await fetchSupermemory(
      config,
      requestUrl(config.baseUrl, `/v3/container-tags/${encodeURIComponent(containerTag)}`),
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        redirect: "error",
        signal: requestSignal(signal),
      },
    );
    try {
      if (response.ok || response.status === 404) return { ok: true };
      if (response.status === 403) return { ok: false, error: SUPERMEMORY_DELETE_FORBIDDEN_ERROR };
      return { ok: false, error: `Supermemory container delete failed: ${response.status}` };
    } finally {
      await releaseUnreadBody(response);
    }
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}

export async function saveSupermemoryMemory(
  content: string,
  containerTag: string,
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SupermemorySaveResponse> {
  const memory = content.trim().slice(0, MAX_MEMORY_CONTENT_CHARS);
  if (!memory) {
    return { ok: false, error: "Supermemory save skipped: memory content is empty." };
  }
  try {
    const response = await fetchSupermemory(config, requestUrl(config.baseUrl, "/v4/memories"), {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ containerTag, memories: [{ content: memory, isStatic: false }] }),
      redirect: "error",
      signal: requestSignal(signal),
    });
    try {
      if (!response.ok) {
        return { ok: false, error: `Supermemory save failed: ${response.status}` };
      }
      return { ok: true };
    } finally {
      await releaseUnreadBody(response);
    }
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}

export async function saveSupermemoryMemoryToContainers(
  content: string,
  containerTags: string[],
  config: SupermemoryConnectionConfig,
  signal?: AbortSignal,
): Promise<SupermemorySaveResponse> {
  const results = await Promise.all(
    containerTags.map(async (containerTag) => ({
      containerTag,
      result: await saveSupermemoryMemory(content, containerTag, config, signal),
    })),
  );
  const failures = results.filter(
    (entry): entry is { containerTag: string; result: { ok: false; error: string } } =>
      !entry.result.ok,
  );
  return failures.length === 0
    ? { ok: true }
    : {
        ok: false,
        error: failures
          .map(({ containerTag, result }) => `${containerTag}: ${result.error}`)
          .join("; "),
      };
}

export async function probeSupermemory(
  config: SupermemoryConnectionConfig,
): Promise<SupermemoryProbeResponse> {
  try {
    const response = await fetchSupermemory(
      config,
      requestUrl(config.baseUrl, "/v3/container-tags/list"),
      {
        method: "GET",
        headers: authHeaders(config),
        redirect: "error",
        signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
      },
    );
    try {
      if (!response.ok) {
        return { ok: false, error: `Supermemory rejected the connection: ${response.status}` };
      }
      return { ok: true };
    } finally {
      await releaseUnreadBody(response);
    }
  } catch (error) {
    return { ok: false, error: unreachableError(error) };
  }
}
