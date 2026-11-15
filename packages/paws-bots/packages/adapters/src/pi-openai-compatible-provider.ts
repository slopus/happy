import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelApiProtocol } from "@rakazo/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  ipVersion,
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isNonPublicAddress,
  MODEL_KEY_REJECTED_ERROR,
  parseModelHeaders,
} from "@rakazo/contracts";
import type { Dispatcher } from "undici";
import { Agent } from "undici";
import { declaredVisionModelIds, inputModalities } from "./model-modalities.js";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { createAddressCheckedLookup } from "./network-address.js";
import type { OpenAiCompatibleUrlPolicy } from "./openai-compatible-url.js";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  isPrivateOpenAiCompatibleHostname,
  loopbackOnHost,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  PRIVATE_MODEL_ENDPOINT_MESSAGE,
} from "./openai-compatible-url.js";
import {
  MODEL_CONNECT_TIMEOUT_MS,
  MODEL_STREAM_AGENT_TIMEOUTS,
  modelConnectTimeoutMs,
} from "./pi-runtime-limits.js";
import { splitLeadingThinkBlock } from "./pi-think-tags.js";
import { guardToolCallNames } from "./pi-tool-call-guard.js";
import { createCheckedProxyDispatcher } from "./proxy-dispatcher.js";
import { dispatcherFetch, fetchPairedWithDispatcher } from "./undici-fetch.js";

export { OPENAI_COMPATIBLE_PROVIDER_ID };

/** Placeholder catalog model id; users enter the real id when connecting. */
export const OPENAI_COMPATIBLE_CATALOG_MODEL_ID = "custom";

/** Model ids this endpoint serves with vision, declared by the operator. */
export const OPENAI_COMPATIBLE_VISION_MODELS_ENV = "RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS";

export function openAiCompatibleVisionModelIds(): ReadonlySet<string> {
  return declaredVisionModelIds(OPENAI_COMPATIBLE_VISION_MODELS_ENV);
}

/** Custom endpoints can be aggregators; keep their discovery bounded below pinned catalogs. */
const MAX_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_IDS = 4_000;
/** Pinned catalogs (OpenRouter is ~1 MiB). Custom server URLs stay on the tight caps. */
const CATALOG_MAX_MODELS_RESPONSE_BYTES = 8 * 1024 * 1024;
const CATALOG_MAX_MODEL_IDS = 8_000;
const MAX_MODEL_ID_LENGTH = 256;

function modelsProbeLimits(catalogProbe?: boolean): { maxBytes: number; maxModelIds: number } {
  return catalogProbe
    ? { maxBytes: CATALOG_MAX_MODELS_RESPONSE_BYTES, maxModelIds: CATALOG_MAX_MODEL_IDS }
    : { maxBytes: MAX_MODELS_RESPONSE_BYTES, maxModelIds: MAX_MODEL_IDS };
}

const OPENAI_COMPAT_BASE = "http://127.0.0.1:1/v1";
/** The version the Anthropic SDK pins; mirrored by the keyless-server probe. */
const ANTHROPIC_MESSAGES_VERSION = "2023-06-01";
const resolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export function openAiCompatibleModel(
  id: string,
  baseUrl: string,
  reasoning = false,
  acceptsImages = false,
  maxTokens = DEFAULT_MODEL_MAX_TOKENS,
  contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
  apiProtocol: ModelApiProtocol = "chat-completions",
): Model<"openai-completions" | "openai-responses" | "anthropic-messages"> {
  return {
    id,
    name: id,
    api:
      apiProtocol === "responses"
        ? "openai-responses"
        : apiProtocol === "anthropic-messages"
          ? "anthropic-messages"
          : "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: apiProtocol === "anthropic-messages" ? anthropicMessagesBaseUrl(baseUrl) : baseUrl,
    reasoning,
    ...(apiProtocol === "anthropic-messages"
      ? // pi-ai derives budget-based thinking from `reasoning` alone, which newer models
        // reject; a model the built-in catalog knows keeps its own thinking settings.
        anthropicCatalogThinking(id)
      : {
          compat: {
            // `store: false` is already the default, and Google's endpoint rejects the field.
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: reasoning,
            thinkingFormat: "openai",
          },
          thinkingLevelMap: reasoning
            ? { off: "none", xhigh: "xhigh", max: "max" }
            : { off: "none" },
        }),
    input: inputModalities(acceptsImages),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

let anthropicCatalog: ReturnType<typeof builtinModels> | undefined;

/**
 * The built-in Anthropic catalog's thinking settings for the same model id, if any. Only the
 * thinking shape is copied: the catalog's other flags (mid-conversation effort and system
 * messages, fallbacks) describe Anthropic's own API, which a compatible endpoint may not accept.
 */
function anthropicCatalogThinking(
  id: string,
): Pick<Model<"anthropic-messages">, "compat" | "thinkingLevelMap"> {
  anthropicCatalog ??= builtinModels();
  const known = anthropicCatalog.getModel("anthropic", id) as
    | Model<"anthropic-messages">
    | undefined;
  if (known?.api !== "anthropic-messages") return {};
  return {
    ...(known.compat?.forceAdaptiveThinking ? { compat: { forceAdaptiveThinking: true } } : {}),
    ...(known.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
  };
}

/**
 * The Anthropic SDK appends `/v1/messages` itself, so the endpoint it gets must
 * not carry the `/v1` the normalized OpenAI-style base URL ends with.
 */
function anthropicMessagesBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/*$/, "");
  return url.toString().replace(/\/$/, "");
}

function openAiCompatibleProvider(
  models: Model<"openai-completions" | "openai-responses" | "anthropic-messages">[],
  policy: { allowPrivate?: boolean; headers?: Record<string, string> } = {},
): Provider {
  const api = (protocol: string) =>
    protocol === "openai-responses"
      ? openAIResponsesApi()
      : protocol === "anthropic-messages"
        ? anthropicMessagesApi()
        : openAICompletionsApi();
  // Guard the fetch the caller supplied (the runtime's seam for tests) or the
  // dispatcher-matched default; never the bare global.
  const streamPolicy = { ...policy, modelStream: true };
  // Only chat completions carries thoughts inside the answer text; the other protocols have
  // their own reasoning blocks.
  const answerOnly = (model: Model<Api>, stream: AssistantMessageEventStream) =>
    model.api === "openai-completions" ? splitLeadingThinkBlock(stream) : stream;
  const safeApi: ProviderStreams = {
    stream: (model, context, options) =>
      answerOnly(
        model,
        api(model.api).stream(model, context, {
          ...options,
          fetch: createOpenAiCompatibleFetch(options?.fetch, undefined, streamPolicy),
        }),
      ),
    streamSimple: (model, context, options) =>
      answerOnly(
        model,
        api(model.api).streamSimple(model, context, {
          ...options,
          fetch: createOpenAiCompatibleFetch(options?.fetch, undefined, streamPolicy),
        }),
      ),
  };
  return createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: "OpenAI-compatible",
    baseUrl: models[0]?.baseUrl ?? OPENAI_COMPAT_BASE,
    auth: {
      apiKey: {
        name: "OpenAI-compatible server",
        resolve: async () => ({
          auth: { apiKey: "local" },
          source: "OpenAI-compatible endpoint",
        }),
      },
    },
    models,
    api: safeApi,
  });
}

export function createOpenAiCompatibleLookup(
  url: URL,
  resolve: ResolveHostname = resolveHostname,
  opts?: { allowPrivate?: boolean },
): LookupFunction {
  return createAddressCheckedLookup(resolve, openAiCompatibleAddressCheck(url, opts));
}

function openAiCompatibleAddressCheck(
  url: URL,
  opts?: { allowPrivate?: boolean },
): (addresses: ResolvedAddress[]) => void {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const privateHostname = isPrivateOpenAiCompatibleHostname(hostname);
  if (privateHostname && opts?.allowPrivate !== true) {
    throw new Error(PRIVATE_MODEL_ENDPOINT_MESSAGE);
  }
  return (addresses) => {
    if (addresses.length === 0) throw new Error("Model server did not resolve to an address");
    if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
      throw new Error("Model server hostname resolved to a blocked metadata address");
    }
    if (privateHostname) {
      if (
        addresses.some(
          (entry) =>
            ipVersion(entry.address) === 0 ||
            !isNonPublicAddress(entry.address) ||
            isLinkLocalAddress(entry.address),
        )
      ) {
        throw new Error("Local model server hostname resolved outside the private network");
      }
      return;
    }
    if (addresses.some((entry) => isNonPublicAddress(entry.address))) {
      throw new Error("Public model server hostname resolved to a private address");
    }
  };
}

function isAuthHeader(name: string, value: string | null | undefined): boolean {
  const lower = name.toLowerCase();
  return (lower === "authorization" || lower === "x-api-key") && Boolean(value);
}

function headersCarryAuthorization(headers: HeadersInit): boolean {
  const entries =
    headers instanceof Headers || Array.isArray(headers) ? [...headers] : Object.entries(headers);
  return entries.some(([name, value]) => isAuthHeader(name, value));
}

/** Matches fetch: when init.headers is set it replaces Request headers entirely. */
function requestCarriesAuthorization(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.headers !== undefined) return headersCarryAuthorization(init.headers);
  return input instanceof Request ? headersCarryAuthorization(input.headers) : false;
}

export function createOpenAiCompatibleFetch(
  baseFetch: typeof globalThis.fetch = dispatcherFetch,
  resolve: ResolveHostname = resolveHostname,
  opts?: OpenAiCompatibleUrlPolicy & {
    headers?: Record<string, string>;
    /** Model streams leave both waits to the runtime's own timeouts. */
    modelStream?: boolean;
  },
): typeof globalThis.fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = assertAllowedOpenAiCompatibleRequestUrl(
      loopbackOnHost(assertAllowedOpenAiCompatibleRequestUrl(rawUrl, opts)).href,
      opts,
    );
    const customHeaders = opts?.headers === undefined ? undefined : parseModelHeaders(opts.headers);
    if (requestCarriesAuthorization(input, init) || Object.keys(customHeaders ?? {}).length > 0) {
      assertHttpsForKeyedOpenAiCompatibleUrl(
        url,
        requestCarriesAuthorization(input, init) ? "present" : undefined,
        Object.keys(customHeaders ?? {}).length > 0,
      );
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const responseTimeouts = opts?.modelStream ? MODEL_STREAM_AGENT_TIMEOUTS : undefined;
    // Local model servers stay on the direct route; public endpoints honor HTTP(S)_PROXY.
    const dispatcher: Dispatcher = isPrivateOpenAiCompatibleHostname(hostname)
      ? new Agent({
          ...responseTimeouts,
          connect: {
            timeout: modelConnectTimeoutMs(),
            ...(ipVersion(hostname) === 0
              ? { lookup: createOpenAiCompatibleLookup(url, resolve, opts) }
              : {}),
          },
        })
      : createCheckedProxyDispatcher(
          resolve,
          openAiCompatibleAddressCheck(url, opts),
          modelConnectTimeoutMs(),
          responseTimeouts,
        );
    // Node's fetch rejects this package Agent. Use its matching fetch;
    // a caller-supplied fetch stays in charge.
    const transport = fetchPairedWithDispatcher(baseFetch);
    try {
      const requestInit = await requestInitFor(input, init);
      let headers = requestInit.headers;
      if (customHeaders !== undefined && Object.keys(customHeaders).length > 0) {
        const merged = new Headers(headers);
        for (const [name, value] of Object.entries(customHeaders)) merged.set(name, value);
        headers = merged;
      }
      const response = await transport(url, {
        ...requestInit,
        headers,
        redirect: "error",
        dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });
      return await closeDispatcherWithResponse(response, dispatcher);
    } catch (error) {
      await dispatcher.destroy().catch(() => undefined);
      throw error;
    }
  };
}

/** The base fetch comes from the undici package, which recognizes only its own
 * Request class and reads a global Request as the string "[object Request]".
 * Flatten Request inputs to a URL plus init, with init overriding the
 * Request's fields the way fetch itself merges them. */
async function requestInitFor(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
  if (!(input instanceof Request)) return init ?? {};
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  };
}

async function closeDispatcherWithResponse(
  response: Response,
  dispatcher: Dispatcher,
): Promise<Response> {
  if (!response.body) {
    await dispatcher.close();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await dispatcher.close().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Always-visible catalog provider with a placeholder model entry. */
export function openAiCompatibleCatalogProvider(): Provider {
  // The vision gate resolves against this catalog, not the per-run registry, so
  // declared vision models are registered here too. A declared placeholder id
  // upgrades the placeholder in place: Models.getModel returns the first match.
  const visionIds = openAiCompatibleVisionModelIds();
  const placeholderAcceptsImages = visionIds.has(OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
  const visionModels = [...visionIds]
    .filter((id) => id !== OPENAI_COMPATIBLE_CATALOG_MODEL_ID)
    .map((id) => openAiCompatibleModel(id, OPENAI_COMPAT_BASE, false, true));
  return openAiCompatibleProvider([
    {
      ...openAiCompatibleModel(
        OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
        OPENAI_COMPAT_BASE,
        false,
        placeholderAcceptsImages,
      ),
      name: "Custom model id",
    },
    ...visionModels,
  ]);
}

export function registerOpenAiCompatibleCatalog(models: MutableModels): MutableModels {
  models.setProvider(openAiCompatibleCatalogProvider());
  return guardToolCallNames(models, OPENAI_COMPATIBLE_PROVIDER_ID);
}

export function registerOpenAiCompatibleRuntime(
  models: MutableModels,
  opts: {
    modelId: string;
    baseUrl: string;
    apiProtocol?: ModelApiProtocol;
    headers?: Record<string, string>;
    reasoning?: boolean;
    acceptsImages?: boolean;
    maxTokens?: number;
    contextWindow?: number;
    /** Explicit operator authorization for private endpoints. */
    allowPrivate?: boolean;
  },
): MutableModels {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  const modelId = opts.modelId.trim();
  const acceptsImages = opts.acceptsImages || openAiCompatibleVisionModelIds().has(modelId);
  models.setProvider(
    openAiCompatibleProvider(
      [
        openAiCompatibleModel(
          modelId,
          baseUrl,
          opts.reasoning,
          acceptsImages,
          opts.maxTokens,
          opts.contextWindow,
          opts.apiProtocol,
        ),
      ],
      { allowPrivate: opts.allowPrivate, headers: opts.headers },
    ),
  );
  return guardToolCallNames(models, OPENAI_COMPATIBLE_PROVIDER_ID);
}

export type OpenAiCompatibleConnectInput = {
  provider: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

export function prepareOpenAiCompatibleConnect(
  input: OpenAiCompatibleConnectInput,
  policy?: { allowPrivate?: boolean },
): {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
} {
  const baseUrl = input.baseUrl?.trim();
  const modelId = input.modelId?.trim();
  if (!baseUrl) throw new Error("Base URL is required for OpenAI-compatible models");
  if (!modelId) throw new Error("Model id is required for OpenAI-compatible models");
  const allowed = assertAllowedOpenAiCompatibleUrl(baseUrl, policy);
  const apiKey = input.apiKey?.trim();
  assertHttpsForKeyedOpenAiCompatibleUrl(
    allowed,
    apiKey,
    Object.keys(input.headers ?? {}).length > 0,
  );
  const normalized = allowed.href;
  return apiKey ? { baseUrl: normalized, modelId, apiKey } : { baseUrl: normalized, modelId };
}

export type OpenAiCompatibleModelsResponse = {
  object?: string;
  data?: Array<{ id?: string }>;
  models?: Array<{ id?: string }>;
  has_more?: boolean;
  last_id?: string | null;
};

/** Shared suffix: /models probe is optional when the user already knows a model id. */
const OPENAI_COMPAT_PROBE_HAND_FILL_HINT = "You can still Connect with an explicit model id.";

/** Extracts model ids; valid JSON can still be null or lack a list, which gets the actionable missing-list error. */
function probeModelIds(
  body: OpenAiCompatibleModelsResponse,
  opts?: { catalogProbe?: boolean },
): string[] {
  const { maxModelIds } = modelsProbeLimits(opts?.catalogProbe);
  const entries = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : null;
  if (!entries) {
    throw new Error(
      `Model server response did not include a models list. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (id.length > MAX_MODEL_ID_LENGTH || ids.length >= maxModelIds) {
      throw new Error("Model server returned too many or overly long model ids");
    }
    ids.push(id);
  }
  return ids;
}

async function readBoundedJson(
  response: Response,
  opts?: { catalogProbe?: boolean },
): Promise<OpenAiCompatibleModelsResponse> {
  const { maxBytes } = modelsProbeLimits(opts?.catalogProbe);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
  if (!response.body) {
    throw new Error(
      `Model server returned an empty response. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as OpenAiCompatibleModelsResponse;
  } catch {
    throw new Error(`Model server returned invalid JSON. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
}

/** Some compatible servers expose their model list without authenticating. */
export async function verifyOpenAiCompatibleApiKey(
  input: { baseUrl: string; apiKey?: string; headers?: Record<string, string> },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  if (new URL(input.baseUrl).hostname !== "ollama.com") return;
  if (!input.apiKey?.trim()) throw new Error(MODEL_KEY_REJECTED_ERROR);
  const safeFetch = createOpenAiCompatibleFetch(fetchImpl);
  let response: Response;
  try {
    response = await safeFetch("https://ollama.com/api/balance", {
      headers: { Authorization: `Bearer ${input.apiKey.trim()}` },
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(MODEL_CONNECT_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch {
    throw new Error("Could not verify the API key. Try again.");
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new Error(MODEL_KEY_REJECTED_ERROR);
  }
  if (!response.ok) throw new Error("Could not verify the API key. Try again.");
}

const CONNECTION_REFUSED_MESSAGE = "Could not reach the model server. Check that it's running.";

/** undici keeps the refusal in `cause`, or in each address's error of a happy-eyeballs AggregateError. */
function connectionRefused(error: unknown, depth = 0): boolean {
  if (depth > 4 || !(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === "ECONNREFUSED") return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((inner) => connectionRefused(inner, depth + 1))
  )
    return true;
  return connectionRefused(error.cause, depth + 1);
}

export async function probeOpenAiCompatibleModels(
  input: {
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    apiProtocol?: ModelApiProtocol;
  },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
  opts?: OpenAiCompatibleUrlPolicy & { catalogProbe?: boolean },
): Promise<string[]> {
  const baseUrl = assertAllowedOpenAiCompatibleUrl(input.baseUrl, opts);
  assertHttpsForKeyedOpenAiCompatibleUrl(
    baseUrl,
    input.apiKey,
    Object.keys(input.headers ?? {}).length > 0,
  );
  await verifyOpenAiCompatibleApiKey(input, fetchImpl, signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    // Anthropic Messages authenticates with its own headers, not a Bearer token;
    // the version header is required even when the endpoint needs no key.
    if (input.apiProtocol === "anthropic-messages") {
      headers["anthropic-version"] = ANTHROPIC_MESSAGES_VERSION;
      if (input.apiKey?.trim()) headers["x-api-key"] = input.apiKey.trim();
    } else if (input.apiKey?.trim()) {
      headers.Authorization = `Bearer ${input.apiKey.trim()}`;
    }
    const safeFetch = createOpenAiCompatibleFetch(fetchImpl, undefined, {
      ...opts,
      headers: input.headers,
    });
    const modelsUrl = new URL("models", `${baseUrl.href}/`);
    const ids: string[] = [];
    const cursors = new Set<string>();
    const { maxModelIds } = modelsProbeLimits(opts?.catalogProbe);
    while (true) {
      merged.throwIfAborted();
      const response = await safeFetch(modelsUrl.href, {
        headers,
        redirect: "error",
        signal: merged,
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `Model server redirects are not allowed. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `Model server returned ${response.status}. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
        );
      }
      const body = await readBoundedJson(response, opts);
      const pageIds = probeModelIds(body, opts);
      if (ids.length + pageIds.length > maxModelIds) {
        throw new Error("Model server returned too many or overly long model ids");
      }
      ids.push(...pageIds);
      if (input.apiProtocol !== "anthropic-messages" || body.has_more !== true) return ids;
      const cursor = typeof body.last_id === "string" ? body.last_id : "";
      if (
        !cursor.trim() ||
        cursor.length > MAX_MODEL_ID_LENGTH ||
        cursors.has(cursor) ||
        !pageIds.length
      ) {
        throw new Error(
          `Model server returned invalid pagination. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
        );
      }
      if (ids.length >= maxModelIds) {
        throw new Error("Model server returned too many or overly long model ids");
      }
      cursors.add(cursor);
      modelsUrl.searchParams.set("after_id", cursor);
    }
  } catch (error) {
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError");
    if (aborted) {
      // Caller-cancelled probes keep the original AbortError; the 5s probe budget gets a hint.
      if (signal?.aborted) throw error;
      throw new Error(`Model server probe timed out. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    if (error instanceof TypeError && connectionRefused(error)) {
      throw new Error(CONNECTION_REFUSED_MESSAGE);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
