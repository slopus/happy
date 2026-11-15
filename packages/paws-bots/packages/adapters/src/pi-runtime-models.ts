import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { canonicalPiProviderId, usableModelId } from "@rakazo/contracts";
import { DEFAULT_OPENROUTER_MODEL_ID } from "./deployment-model.js";
import { PiRuntimeCredentialStore, toOAuthCredential } from "./pi-credentials.js";
import { liveModelSibling, withLiveImageInput } from "./pi-live-model.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";
import {
  operatorMaxTokens,
  REASONING_MODEL_MAX_TOKENS,
  resolveCompletionMaxTokens,
} from "./pi-runtime-limits.js";
import { scopedRuntimeModels } from "./pi-runtime-scope.js";

// Built on first use, not at module load: entry points call loadRootEnv() after
// their imports, and ESM hoists those imports, so module-level env reads here
// would run before .env is loaded and miss the local provider entirely.
let catalogModelsCache: Models | undefined;
export function createRuntimeModels(): MutableModels {
  return registerOpenAiCompatibleCatalog(
    registerLocalProvider(applyPiModelCompatibility(builtinModels())),
  );
}
function catalogModels(): Models {
  catalogModelsCache ??= createRuntimeModels();
  return catalogModelsCache;
}

// Reasoning-capable models must not start at "off": for OpenRouter, pi-ai maps
// that to reasoning.effort "none", which 400s on endpoints that mandate
// reasoning (e.g. google/gemini-3.7-flash). Keep a real level when model.reasoning
// is set; plain models stay off.
const REASONING_MODEL_THINKING_LEVEL: ModelThinkingLevel = "medium";
export function thinkingLevelFor(
  model: Model<Api>,
  preferred?: ModelThinkingLevel | null,
): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  if (preferred) return clampThinkingLevel(model, preferred);
  return clampThinkingLevel(model, REASONING_MODEL_THINKING_LEVEL);
}

function configuredOpenRouterModel(
  id: string,
  contextWindow = 16_384,
): Model<"openai-completions"> {
  // A configured model can be newer than Pi's static catalog. Enable reasoning:
  // unknown OpenRouter endpoints often mandate it and reject effort "none".
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(REASONING_MODEL_MAX_TOKENS, Math.max(1, Math.floor(contextWindow / 2))),
  };
}

export function resolveRuntimeModel(modelConfig: AgentRunRequest["model"]): {
  provider: string;
  modelId: string;
  models: Models;
  model: Model<Api> | undefined;
  apiKey: string | undefined;
  /** Live credential store; OAuth refreshes swap the credential mid-run. */
  credentials: PiRuntimeCredentialStore | undefined;
} {
  const provider = canonicalPiProviderId(
    modelConfig.provider === "scripted" ? "openrouter" : modelConfig.provider,
  );
  const envDefaultModel = process.env.PI_DEFAULT_MODEL?.trim();
  const envDefaultProvider = process.env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  const requestedId =
    modelConfig.id === "scripted" ? envDefaultModel || DEFAULT_OPENROUTER_MODEL_ID : modelConfig.id;
  const modelId = usableModelId(requestedId) ?? "";
  const credentials = credentialStoreForRequest({ model: modelConfig }, provider);
  const models = modelsForRequest({ model: modelConfig }, provider, credentials);
  let model = models.getModel(provider, modelId);
  if (
    provider === "openrouter" &&
    !model &&
    modelId &&
    ((envDefaultProvider === "openrouter" && modelId === envDefaultModel) ||
      modelConfig.contextWindow !== undefined)
  ) {
    model = configuredOpenRouterModel(modelId, modelConfig.contextWindow);
  }
  // Saved generic limits and deployment defaults take precedence over inferred siblings.
  model ??= liveModelSibling(models, provider, modelId);
  if (model && (modelConfig.contextWindow !== undefined || modelConfig.maxTokens !== undefined)) {
    model = {
      ...model,
      ...(modelConfig.contextWindow !== undefined
        ? { contextWindow: modelConfig.contextWindow }
        : {}),
      ...(modelConfig.maxTokens !== undefined ? { maxTokens: modelConfig.maxTokens } : {}),
    };
  }
  if (model && provider === CHATGPT_OAUTH_PROVIDER) {
    model = withLiveImageInput(model, modelConfig.acceptsImages);
  }
  const apiKey = modelConfig.oauth
    ? undefined
    : modelConfig.provider === OPENAI_COMPATIBLE_PROVIDER_ID
      ? modelConfig.apiKey || "local"
      : // Only OpenRouter may fall back to the OpenRouter env key. Handing it to
        // another provider would ship our key to a vendor it was not issued for.
        (modelConfig.apiKey ??
        (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined));
  return { provider, modelId, models, model, apiKey, credentials };
}

function credentialStoreForRequest(
  request: Pick<AgentRunRequest, "model">,
  provider: string,
): PiRuntimeCredentialStore | undefined {
  const oauth = request.model.oauth;
  if (!oauth) return undefined;
  const persist = oauth.persist;
  return new PiRuntimeCredentialStore(
    provider,
    toOAuthCredential(oauth.credential),
    persist ? (next) => persist(next) : undefined,
    oauth.retire,
    oauth.refresh,
  );
}

export function modelsForRequest(
  request: Pick<AgentRunRequest, "model">,
  provider: string,
  credentials?: PiRuntimeCredentialStore,
): Models {
  const store = credentials ?? credentialStoreForRequest(request, provider);
  if (store) {
    return registerOpenAiCompatibleCatalog(
      registerLocalProvider(applyPiModelCompatibility(builtinModels({ credentials: store }))),
    );
  }
  if (
    provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
    request.model.baseUrl &&
    request.model.id.trim()
  ) {
    const models = registerOpenAiCompatibleCatalog(
      registerLocalProvider(applyPiModelCompatibility(builtinModels())),
    );
    return registerOpenAiCompatibleRuntime(models, {
      modelId: request.model.id,
      baseUrl: request.model.baseUrl,
      apiProtocol: request.model.apiProtocol,
      headers: request.model.headers,
      allowPrivate: request.model.allowPrivateEndpoint,
      reasoning: request.model.reasoning,
      acceptsImages: request.model.acceptsImages,
      maxTokens: request.model.maxTokens,
      contextWindow: request.model.contextWindow,
    });
  }
  return scopedRuntimeModels() ?? catalogModels();
}

export function modelForCompletion(model: Model<Api>, configuredMaxTokens?: number): Model<Api> {
  const maxTokens = resolveCompletionMaxTokens(
    model.maxTokens,
    configuredMaxTokens,
    undefined,
    model.reasoning,
    undefined,
    operatorMaxTokens(model),
  );
  if (maxTokens === model.maxTokens) return model;
  return { ...model, maxTokens };
}

export interface RuntimeModelTarget {
  config: AgentRunRequest["model"];
  models: Models;
  model: Model<Api>;
  /** The model card's output ceiling, before the completion default caps `model.maxTokens`. */
  cardMaxTokens?: number;
  apiKey?: string;
  credentials?: PiRuntimeCredentialStore;
}

/** A provider request ceiling applies only to this run, never to saved connection settings. */
export function resizeRuntimeTarget(
  target: RuntimeModelTarget,
  contextWindow: number,
): RuntimeModelTarget {
  return {
    ...target,
    config: { ...target.config, contextWindow },
    model: { ...target.model, contextWindow },
  };
}

/**
 * An OpenAI-compatible model's card carries the default, not the endpoint's ceiling, which
 * is unknown unless the connection sets one; then only the input reserve bounds a raise.
 */
export function cardOutputCeiling(model: Model<Api>): number | undefined {
  return model.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? undefined : model.maxTokens;
}

export function withOutputBudget(
  target: RuntimeModelTarget,
  maxTokens: number,
): RuntimeModelTarget {
  return {
    ...target,
    config: { ...target.config, maxTokens },
    model: { ...target.model, maxTokens },
  };
}

/** "Unsupported reasoning effort", "invalid reasoning_effort", "reasoning effort is not supported". */
const UNSUPPORTED_REASONING_EFFORT =
  /\b(?:unsupported|invalid) reasoning[ _]effort\b|\breasoning[ _]effort\b[^.;:\n]{0,30}?\b(?:not supported|unsupported|invalid)\b/i;

const REASONING_EFFORT_CHOICES =
  /\breasoning_effort\b[\s\S]{0,120}?\b(?:one of|supported values)\b\s*(?:are|:)?\s*([^.}"]*)/i;

/**
 * The thinking levels of a model whose endpoint rejected `reasoning_effort` and listed the values
 * it accepts, with the rest mapped out so the request clamps to an accepted one. Off sends no
 * effort when the endpoint refuses the off value, or refuses an effort without listing any.
 * Undefined when the error gives nothing usable.
 */
export function acceptedReasoningEfforts(
  model: Model<Api>,
  errorMessage: string | undefined,
): ThinkingLevelMap | undefined {
  const listed = errorMessage?.match(REASONING_EFFORT_CHOICES)?.[1]?.toLowerCase().match(/\w+/g);
  const current = model.thinkingLevelMap ?? {};
  if (!listed) {
    // Some gateways refuse an effort without naming the accepted ones ("Unsupported reasoning
    // effort"). The off value is the one a model most often lacks, so off then sends no effort.
    return typeof current.off === "string" && UNSUPPORTED_REASONING_EFFORT.test(errorMessage ?? "")
      ? { ...current, off: null }
      : undefined;
  }
  const accepted = new Set(listed);
  const levels: ThinkingLevelMap = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const effort = current[level] ?? (level === "xhigh" || level === "max" ? null : level);
    levels[level] = effort !== null && accepted.has(effort) ? effort : null;
  }
  if (Object.values(levels).every((effort) => effort === null)) return undefined;
  if (typeof current.off === "string" && accepted.has(current.off)) levels.off = current.off;
  return levels;
}

type ModelTarget = Pick<AgentRunRequest["model"], "provider" | "id" | "connectionId">;

/** A model on one connection: the same model on another account is another backup. */
export function modelTargetKey(target: ModelTarget): string {
  return JSON.stringify([target.provider, target.id, target.connectionId ?? null]);
}

export function sameModelTarget(left: ModelTarget, right: ModelTarget): boolean {
  return modelTargetKey(left) === modelTargetKey(right);
}
