import type { Model, MutableModels, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent } from "undici";
import { declaredVisionModelIds, inputModalities } from "./model-modalities.js";
import { LOCAL_PROVIDER_ID, localModelIds, localModelsApiKey } from "./pi-local-provider-id.js";
import { MODEL_STREAM_AGENT_TIMEOUTS } from "./pi-runtime-limits.js";
import { splitLeadingThinkBlock } from "./pi-think-tags.js";
import { pacerTokensPerMinute } from "./token-pacer.js";
import { fetchPairedWithDispatcher } from "./undici-fetch.js";

/**
 * Local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, MLX).
 * Without RAKAZO_LOCAL_MODELS_API_KEY the server is keyless, but `resolve` returns
 * a placeholder because Models hides providers with no resolvable auth.
 */
export { LOCAL_PROVIDER_ID };

/** Model ids the local server serves with vision, declared by the operator. */
export const LOCAL_VISION_MODELS_ENV = "RAKAZO_LOCAL_VISION_MODELS";

export function localVisionModelIds(): ReadonlySet<string> {
  return declaredVisionModelIds(LOCAL_VISION_MODELS_ENV);
}

/** Model ids the local server serves with OpenAI-style `reasoning_effort`, declared by the operator. */
export const LOCAL_REASONING_MODELS_ENV = "RAKAZO_LOCAL_REASONING_MODELS";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;

export function localBaseUrl(): string {
  const value = process.env.RAKAZO_LOCAL_MODELS_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RAKAZO_LOCAL_MODELS_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RAKAZO_LOCAL_MODELS_URL must be an absolute HTTP(S) URL");
  }
  return value;
}

/** Throws instead of `Number(x) || default`, which would swallow a typo or accept a negative window. */
function tokenLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

function localModel(id: string): Model<"openai-completions"> {
  // Same comma-separated id list as the vision opt-in.
  const reasoning = declaredVisionModelIds(LOCAL_REASONING_MODELS_ENV).has(id);
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: LOCAL_PROVIDER_ID,
    baseUrl: localBaseUrl(),
    reasoning,
    compat: reasoning
      ? { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: "openai" }
      : { supportsDeveloperRole: false, supportsReasoningEffort: false },
    // Mirrors openAiCompatibleModel's reasoning levels.
    ...(reasoning ? { thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" } } : {}),
    input: inputModalities(localVisionModelIds().has(id)),
    // Runs on the operator's own hardware, so there is nothing to bill.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: tokenLimit("RAKAZO_LOCAL_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: tokenLimit("RAKAZO_LOCAL_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

let localDispatcher: Dispatcher | undefined;

/** Node's built-in fetch, which local servers used before, honors HTTP(S)_PROXY only when asked to. */
function nodeFetchUsesEnvProxy(): boolean {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS?.split(/\s+/) ?? [])];
  return process.env.NODE_USE_ENV_PROXY === "1" || flags.includes("--use-env-proxy");
}

/** A queued local server can stay silent for minutes; the runtime's own timeouts bound it. */
function localModelFetch(baseFetch?: typeof globalThis.fetch): typeof globalThis.fetch {
  localDispatcher ??= nodeFetchUsesEnvProxy()
    ? new EnvHttpProxyAgent(MODEL_STREAM_AGENT_TIMEOUTS)
    : new Agent(MODEL_STREAM_AGENT_TIMEOUTS);
  const dispatcher = localDispatcher;
  const transport = fetchPairedWithDispatcher(baseFetch);
  return (input, init) =>
    transport(input, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher });
}

function localApi(): ProviderStreams {
  const api = openAICompletionsApi();
  return {
    stream: (model, context, options) =>
      splitLeadingThinkBlock(
        api.stream(model, context, { ...options, fetch: localModelFetch(options?.fetch) }),
      ),
    streamSimple: (model, context, options) =>
      splitLeadingThinkBlock(
        api.streamSimple(model, context, { ...options, fetch: localModelFetch(options?.fetch) }),
      ),
  };
}

export function localProvider(): Provider | undefined {
  const ids = localModelIds();
  if (!ids.length) return undefined;
  // Fail on a bad pacing limit with the other token limits, not on the first model call.
  pacerTokensPerMinute(LOCAL_PROVIDER_ID);
  return createProvider({
    id: LOCAL_PROVIDER_ID,
    name: "Local (Ollama / LM Studio)",
    baseUrl: localBaseUrl(),
    auth: {
      apiKey: {
        name: "Local model server",
        resolve: async () => ({
          auth: { apiKey: localModelsApiKey() ?? "local", baseUrl: localBaseUrl() },
          source: "local model server",
        }),
      },
    },
    models: ids.map(localModel),
    api: localApi(),
  });
}

export function registerLocalProvider(models: MutableModels): MutableModels {
  const provider = localProvider();
  if (provider) models.setProvider(provider);
  return models;
}
