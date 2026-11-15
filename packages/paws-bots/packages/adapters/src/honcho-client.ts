import type { LocalServiceConnection } from "./local-service-endpoint.js";
import { fetchLocalService } from "./local-service-endpoint.js";
import { truncateUtf8 } from "./utf8.js";
import { readBodyCapped } from "./web-ssrf.js";

export const HONCHO_CLOUD_BASE_URL = "https://api.honcho.dev";

const HONCHO_TIMEOUT_MS = 15_000;
/** Peer chat runs Honcho's dialectic agent, which reasons over memory before answering. */
const HONCHO_CHAT_TIMEOUT_MS = 60_000;
const MAX_HONCHO_RESPONSE_BYTES = 1024 * 1024;

/**
 * Honcho rejects conclusions over its 8192-token embedding limit. Every o200k token is at least
 * one UTF-8 byte, so a byte cap stays under it even for CJK text, where a character cap would not.
 */
export const MAX_HONCHO_CONCLUSION_BYTES = 8192;

/** Honcho rejects dialectic queries longer than this. */
const MAX_HONCHO_CHAT_QUERY_CHARS = 10_000;

export const HONCHO_REASONING_LEVELS = ["minimal", "low", "medium", "high", "max"] as const;
export type HonchoReasoningLevel = (typeof HONCHO_REASONING_LEVELS)[number];

export interface HonchoConnectionConfig extends LocalServiceConnection {
  apiKey: string;
  reasoningLevel: HonchoReasoningLevel;
}

export type HonchoResponse<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HonchoConclusion {
  content: string;
  observerId: string;
  observedId: string;
}

export interface HonchoStoredConclusion extends HonchoConclusion {
  id: string;
}

export function isHonchoConclusionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
}

/** Honcho resource ids allow letters, digits, `_` and `-` only. */
export function honchoResourceId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 512);
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function honchoRequest(
  config: HonchoConnectionConfig,
  path: string,
  body: unknown,
  options: {
    method?: "GET" | "POST" | "DELETE";
    timeoutMs?: number;
    signal?: AbortSignal;
    readJson?: boolean;
    /** Answer 404 with `null` instead of an error. */
    allowNotFound?: boolean;
  } = {},
): Promise<HonchoResponse<unknown>> {
  const signal = requestSignal(options.timeoutMs ?? HONCHO_TIMEOUT_MS, options.signal);
  const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const method = options.method ?? "POST";
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal,
  };
  let response: Response;
  try {
    response =
      config.baseUrl === HONCHO_CLOUD_BASE_URL
        ? await (config.fetch ?? fetch)(url, init)
        : await fetchLocalService(config, url, init);
  } catch {
    return {
      ok: false,
      error: "Honcho is unreachable or the request timed out.",
    };
  }
  if (!response.ok || !options.readJson) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404 && options.allowNotFound) return { ok: true, value: null };
    return response.ok
      ? { ok: true, value: undefined }
      : { ok: false, error: `Honcho request failed: ${response.status}` };
  }
  try {
    const bytes = await readBodyCapped(response, MAX_HONCHO_RESPONSE_BYTES, signal);
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      ok: false,
      error: "Honcho returned an unreadable response.",
    };
  }
}

function workspacePath(workspaceId: string): string {
  return `/v3/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** Get-or-create. Also proves the key can write to the workspace. */
export async function ensureHonchoWorkspace(
  config: HonchoConnectionConfig,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HonchoResponse<void>> {
  const result = await honchoRequest(config, "/v3/workspaces", { id: workspaceId }, { signal });
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Listing workspaces needs an admin key and writes nothing. */
export async function probeHonchoAdminKey(
  config: HonchoConnectionConfig,
): Promise<HonchoResponse<void>> {
  const result = await honchoRequest(config, "/v3/workspaces/list?size=1", {});
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Get-or-create the workspace and each peer. */
export async function ensureHonchoPeers(
  config: HonchoConnectionConfig,
  workspaceId: string,
  peerIds: string[],
  signal?: AbortSignal,
): Promise<HonchoResponse<void>> {
  const workspace = await ensureHonchoWorkspace(config, workspaceId, signal);
  if (!workspace.ok) return workspace;
  const results = await Promise.all(
    [...new Set(peerIds)].map((id) =>
      honchoRequest(config, `${workspacePath(workspaceId)}/peers`, { id }, { signal }),
    ),
  );
  const failure = results.find((result) => !result.ok);
  return failure && !failure.ok ? failure : { ok: true, value: undefined };
}

export async function createHonchoConclusions(
  config: HonchoConnectionConfig,
  workspaceId: string,
  conclusions: HonchoConclusion[],
  signal?: AbortSignal,
): Promise<HonchoResponse<void>> {
  const result = await honchoRequest(
    config,
    `${workspacePath(workspaceId)}/conclusions`,
    {
      conclusions: conclusions.map((conclusion) => ({
        content: conclusion.content,
        observer_id: conclusion.observerId,
        observed_id: conclusion.observedId,
      })),
    },
    { signal },
  );
  return result.ok ? { ok: true, value: undefined } : result;
}

function parseConclusion(value: unknown): HonchoStoredConclusion | undefined {
  const conclusion = value as Record<string, unknown> | null;
  if (
    !isHonchoConclusionId(conclusion?.id) ||
    typeof conclusion.content !== "string" ||
    typeof conclusion.observer_id !== "string" ||
    typeof conclusion.observed_id !== "string"
  ) {
    return undefined;
  }
  return {
    id: conclusion.id,
    content: conclusion.content,
    observerId: conclusion.observer_id,
    observedId: conclusion.observed_id,
  };
}

/** Semantic search over the conclusions one peer holds about another. */
export async function queryHonchoConclusions(
  config: HonchoConnectionConfig,
  workspaceId: string,
  request: { query: string; observerId: string; observedId: string; topK: number },
  signal?: AbortSignal,
): Promise<HonchoResponse<HonchoStoredConclusion[]>> {
  const result = await honchoRequest(
    config,
    `${workspacePath(workspaceId)}/conclusions/query`,
    {
      // The query is embedded, so it shares the conclusion embedding limit.
      query: truncateUtf8(request.query, MAX_HONCHO_CONCLUSION_BYTES),
      top_k: Math.min(Math.max(request.topK, 1), 100),
      filters: { observer_id: request.observerId, observed_id: request.observedId },
    },
    { signal, readJson: true },
  );
  if (!result.ok) return result;
  const conclusions = Array.isArray(result.value) ? result.value.map(parseConclusion) : [undefined];
  if (conclusions.some((conclusion) => !conclusion)) {
    return { ok: false, error: "Honcho returned invalid conclusions." };
  }
  return { ok: true, value: conclusions as HonchoStoredConclusion[] };
}

/** Fetching a conclusion by id needs Honcho v3.2 or later. Missing conclusions are `null`. */
export async function getHonchoConclusion(
  config: HonchoConnectionConfig,
  workspaceId: string,
  conclusionId: string,
  signal?: AbortSignal,
): Promise<HonchoResponse<HonchoStoredConclusion | null>> {
  if (!isHonchoConclusionId(conclusionId)) {
    return { ok: false, error: "Invalid Honcho conclusion id." };
  }
  const result = await honchoRequest(
    config,
    `${workspacePath(workspaceId)}/conclusions/${encodeURIComponent(conclusionId)}`,
    undefined,
    { method: "GET", signal, readJson: true, allowNotFound: true },
  );
  if (!result.ok) return result;
  if (result.value === null) return { ok: true, value: null };
  const conclusion = parseConclusion(result.value);
  return conclusion
    ? { ok: true, value: conclusion }
    : { ok: false, error: "Honcho returned an invalid conclusion." };
}

/** Deleting an already missing conclusion succeeds. */
export async function deleteHonchoConclusion(
  config: HonchoConnectionConfig,
  workspaceId: string,
  conclusionId: string,
  signal?: AbortSignal,
): Promise<HonchoResponse<void>> {
  if (!isHonchoConclusionId(conclusionId)) {
    return { ok: false, error: "Invalid Honcho conclusion id." };
  }
  const result = await honchoRequest(
    config,
    `${workspacePath(workspaceId)}/conclusions/${encodeURIComponent(conclusionId)}`,
    undefined,
    { method: "DELETE", signal, allowNotFound: true },
  );
  return result.ok ? { ok: true, value: undefined } : result;
}

export async function honchoPeerChat(
  config: HonchoConnectionConfig,
  workspaceId: string,
  request: { peerId: string; target?: string; query: string },
  signal?: AbortSignal,
): Promise<HonchoResponse<string>> {
  const result = await honchoRequest(
    config,
    `${workspacePath(workspaceId)}/peers/${encodeURIComponent(request.peerId)}/chat`,
    {
      query: truncateChars(request.query, MAX_HONCHO_CHAT_QUERY_CHARS),
      reasoning_level: config.reasoningLevel,
      stream: false,
      ...(request.target ? { target: request.target } : {}),
    },
    { timeoutMs: HONCHO_CHAT_TIMEOUT_MS, signal, readJson: true },
  );
  if (!result.ok) return result;
  const content = (result.value as { content?: unknown } | null)?.content;
  // `content` is nullable: the dialectic may have no answer.
  if (content === null) return { ok: true, value: "" };
  if (typeof content !== "string") {
    return { ok: false, error: "Honcho returned an invalid chat response." };
  }
  return { ok: true, value: content.trim() };
}

/** Python counts code points; UTF-16 length is never smaller, so this stays under the limit. */
function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const end = /[\uD800-\uDBFF]/.test(value.charAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}
