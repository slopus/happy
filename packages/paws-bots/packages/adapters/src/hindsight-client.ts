import type { LocalServiceConnection } from "./local-service-endpoint.js";
import { fetchLocalService } from "./local-service-endpoint.js";
import { readBodyCapped } from "./web-ssrf.js";

export const HINDSIGHT_CLOUD_BASE_URL = "https://api.hindsight.vectorize.io";

/** Default request timeout; reflect runs an LLM and can take that long. */
const HINDSIGHT_TIMEOUT_MS = 120_000;
/** Credential and bank checks are interactive setup, not LLM-backed work. */
export const HINDSIGHT_CONNECTION_TIMEOUT_MS = 10_000;
/** Recall runs synchronously before every reply, so a slow server must not stall runs for long. */
export const HINDSIGHT_RECALL_TIMEOUT_MS = 15_000;
/** Clear awaits cleanup; its entire purge must not inherit reflection's LLM-sized timeout. */
export const HINDSIGHT_PURGE_TIMEOUT_MS = 10_000;
/** Polling operation metadata does not run the provider's LLM. */
export const HINDSIGHT_STATUS_TIMEOUT_MS = 10_000;
/** Fact extraction writes have a bounded budget separate from long-form reflection. */
export const HINDSIGHT_WRITE_TIMEOUT_MS = 30_000;
const MAX_HINDSIGHT_RESPONSE_BYTES = 1024 * 1024;

export interface HindsightConnectionConfig extends LocalServiceConnection {
  /** Empty for a self-hosted server without authentication. */
  apiKey: string;
}

export type HindsightResponse<T> = { ok: true; value: T } | { ok: false; error: string };
/** `status` is the HTTP status of a write the server refused. */
export type HindsightWriteResponse =
  | { ok: true; value: undefined }
  | { ok: false; error: string; status?: number };

export interface HindsightRecallResult {
  text: string;
  updatedAt?: string;
  score: number;
}

const INVALID = "Hindsight returned an invalid response.";

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function hindsightRequest(
  config: HindsightConnectionConfig,
  path: string,
  body: unknown,
  options: {
    method?: "GET" | "POST" | "DELETE";
    timeoutMs?: number;
    signal?: AbortSignal;
    readJson?: boolean;
    /** Answer 404 with `null` instead of an error. */
    allowNotFound?: boolean;
    /** Add the HTTP status to a refused request's error. */
    reportStatus?: boolean;
  } = {},
): Promise<{ ok: true; value: unknown } | Extract<HindsightWriteResponse, { ok: false }>> {
  const signal = requestSignal(options.timeoutMs ?? HINDSIGHT_TIMEOUT_MS, options.signal);
  const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const method = options.method ?? "POST";
  const sendsBody = method === "POST";
  const init: RequestInit = {
    method,
    headers: {
      ...(config.apiKey !== "" ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...(sendsBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(sendsBody ? { body: JSON.stringify(body ?? {}) } : {}),
    redirect: "error",
    signal,
  };
  let response: Response;
  try {
    response =
      config.baseUrl === HINDSIGHT_CLOUD_BASE_URL
        ? await (config.fetch ?? fetch)(url, init)
        : await fetchLocalService(config, url, init);
  } catch {
    return { ok: false, error: "Hindsight is unreachable or the request timed out." };
  }
  if (!response.ok || !options.readJson) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404 && options.allowNotFound) return { ok: true, value: null };
    return response.ok
      ? { ok: true, value: undefined }
      : {
          ok: false,
          error: `Hindsight request failed: ${response.status}`,
          ...(options.reportStatus ? { status: response.status } : {}),
        };
  }
  try {
    const bytes = await readBodyCapped(response, MAX_HINDSIGHT_RESPONSE_BYTES, signal);
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, error: "Hindsight returned an unreadable response." };
  }
}

function bankPath(bank: string): string {
  return `/v1/default/banks/${encodeURIComponent(bank)}`;
}

function operationPath(bank: string, operationId: string): string {
  return `${bankPath(bank)}/operations/${encodeURIComponent(operationId)}`;
}

function done(
  result: { ok: true; value: unknown } | Extract<HindsightWriteResponse, { ok: false }>,
): HindsightWriteResponse {
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Listing banks proves the key works and writes nothing. */
export async function probeHindsightKey(
  config: HindsightConnectionConfig,
  signal?: AbortSignal,
): Promise<HindsightResponse<void>> {
  return done(
    await hindsightRequest(config, "/v1/default/banks?limit=1", undefined, {
      method: "GET",
      signal,
      timeoutMs: HINDSIGHT_CONNECTION_TIMEOUT_MS,
    }),
  );
}

export async function hindsightBankExists(
  config: HindsightConnectionConfig,
  bank: string,
  signal?: AbortSignal,
): Promise<HindsightResponse<boolean>> {
  const result = await hindsightRequest(config, `${bankPath(bank)}/config`, undefined, {
    method: "GET",
    signal,
    timeoutMs: HINDSIGHT_CONNECTION_TIMEOUT_MS,
    allowNotFound: true,
  });
  return result.ok ? { ok: true, value: result.value !== null } : result;
}

/** Creates the bank on its first write. */
export async function retainHindsight(
  config: HindsightConnectionConfig,
  bank: string,
  body: object,
  signal?: AbortSignal,
): Promise<HindsightWriteResponse> {
  return done(
    await hindsightRequest(config, `${bankPath(bank)}/memories`, body, {
      signal,
      reportStatus: true,
      timeoutMs: HINDSIGHT_WRITE_TIMEOUT_MS,
    }),
  );
}

/** An async operation's status: pending, processing, completed, failed, cancelled or not_found. */
export async function hindsightOperationStatus(
  config: HindsightConnectionConfig,
  bank: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<HindsightResponse<string>> {
  const result = await hindsightRequest(config, operationPath(bank, operationId), undefined, {
    method: "GET",
    signal,
    readJson: true,
    allowNotFound: true,
    timeoutMs: HINDSIGHT_STATUS_TIMEOUT_MS,
  });
  if (!result.ok) return result;
  if (result.value === null) return { ok: true, value: "not_found" };
  const status =
    result.value && typeof result.value === "object" && "status" in result.value
      ? result.value.status
      : undefined;
  return typeof status === "string" ? { ok: true, value: status } : { ok: false, error: INVALID };
}

function parseRecallResult(value: unknown): HindsightRecallResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  if (typeof result.text !== "string") return undefined;
  const updatedAt = [result.mentioned_at, result.occurred_start].find(
    (date): date is string => typeof date === "string",
  );
  const final = (result.scores as { final?: unknown } | null | undefined)?.final;
  return {
    text: result.text,
    ...(updatedAt ? { updatedAt } : {}),
    score: typeof final === "number" && Number.isFinite(final) ? final : 0,
  };
}

/** A bank nothing was retained to answers 404; it has nothing to find. */
export async function recallHindsight(
  config: HindsightConnectionConfig,
  bank: string,
  body: object,
  signal?: AbortSignal,
  /** Shorter for a bank that must not hold up the bot's own results. */
  timeoutMs = HINDSIGHT_RECALL_TIMEOUT_MS,
): Promise<HindsightResponse<HindsightRecallResult[]>> {
  const result = await hindsightRequest(config, `${bankPath(bank)}/memories/recall`, body, {
    timeoutMs,
    signal,
    readJson: true,
    allowNotFound: true,
  });
  if (!result.ok) return result;
  if (result.value === null) return { ok: true, value: [] };
  const items = (result.value as { results?: unknown } | null)?.results;
  if (!Array.isArray(items)) return { ok: false, error: INVALID };
  const parsed: HindsightRecallResult[] = [];
  for (const item of items) {
    const memory = parseRecallResult(item);
    if (!memory) return { ok: false, error: INVALID };
    parsed.push(memory);
  }
  return { ok: true, value: parsed };
}

/** The synthesized answer; a bank nothing was retained to answers with an empty one. */
export async function reflectHindsight(
  config: HindsightConnectionConfig,
  bank: string,
  body: object,
  signal?: AbortSignal,
): Promise<HindsightResponse<string>> {
  const result = await hindsightRequest(config, `${bankPath(bank)}/reflect`, body, {
    signal,
    readJson: true,
    allowNotFound: true,
  });
  if (!result.ok) return result;
  if (result.value === null) return { ok: true, value: "" };
  const text = (result.value as { text?: unknown } | null)?.text;
  return typeof text === "string" ? { ok: true, value: text } : { ok: false, error: INVALID };
}

/** Deletes the document with its memories; a missing document or bank succeeds. */
export async function deleteHindsightDocument(
  config: HindsightConnectionConfig,
  bank: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<HindsightResponse<void>> {
  return done(
    await hindsightRequest(
      config,
      `${bankPath(bank)}/documents/${encodeURIComponent(documentId)}`,
      undefined,
      { method: "DELETE", signal, timeoutMs: HINDSIGHT_PURGE_TIMEOUT_MS, allowNotFound: true },
    ),
  );
}

/** One page of the ids of documents carrying `tag`; a missing bank has none. */
export async function listHindsightDocumentIdsByTag(
  config: HindsightConnectionConfig,
  bank: string,
  tag: string,
  signal?: AbortSignal,
): Promise<HindsightResponse<string[]>> {
  const query = new URLSearchParams({ tags: tag, tags_match: "all_strict", limit: "100" });
  const result = await hindsightRequest(config, `${bankPath(bank)}/documents?${query}`, undefined, {
    method: "GET",
    signal,
    timeoutMs: HINDSIGHT_PURGE_TIMEOUT_MS,
    readJson: true,
    allowNotFound: true,
  });
  if (!result.ok) return result;
  if (result.value === null) return { ok: true, value: [] };
  const items = (result.value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { ok: false, error: INVALID };
  const ids: string[] = [];
  for (const item of items) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return { ok: false, error: INVALID };
    ids.push(id);
  }
  return { ok: true, value: ids };
}
