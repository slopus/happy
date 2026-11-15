import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { canonicalPiProviderId } from "@rakazo/contracts";
import { CLAUDE_CODE_PROVIDER_ID, claudeCodeModel } from "./cli-models/claude-code/provider.js";
import { DEFAULT_OPENROUTER_MODEL_ID } from "./deployment-model.js";
import { liveModelSibling, withLiveImageInput } from "./pi-live-model.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";

/** Computer tools whose results include screenshots for the model. */
export const IMAGE_RETURNING_COMPUTER_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "open_path",
  "launch_app",
]);

export const MODEL_CANNOT_SEE_MESSAGE = "This bot's model cannot see; pick a vision-capable model.";

export function modelIdSupportsImages(
  modelIds: readonly string[] | undefined,
  modelId: string | null | undefined,
): boolean {
  const normalizedModelId = modelId?.trim();
  return Boolean(
    normalizedModelId && modelIds?.some((candidate) => candidate.trim() === normalizedModelId),
  );
}

/** Whether a compatible connection lists the model as seeing images. */
export function compatibleModelSeesImages(
  credential: { supportsImages?: boolean | null; defaultModel?: string | null },
  secret: { visionModelIds?: readonly string[] },
  modelId: string,
): boolean {
  return (
    modelIdSupportsImages(secret.visionModelIds, modelId) ||
    // Legacy secrets have no per-model list, so keep their existing
    // capability scoped to the model saved in the space preference.
    (secret.visionModelIds === undefined &&
      credential.supportsImages === true &&
      credential.defaultModel?.trim() === modelId.trim())
  );
}

/** Update the explicit per-model image capability without disturbing other model ids. */
export function updateModelImageCapabilities(
  modelIds: readonly string[] | undefined,
  modelId: string | null | undefined,
  supportsImages: boolean | undefined,
): string[] {
  const next = new Set(
    (modelIds ?? [])
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length > 0),
  );
  const normalizedModelId = modelId?.trim();
  if (normalizedModelId && supportsImages !== undefined) {
    if (supportsImages) next.add(normalizedModelId);
    else next.delete(normalizedModelId);
  }
  return [...next];
}

let catalogModelsCache: Models | undefined;

function catalogModels(): Models {
  // Same catalog the runtime calls, including configured compatible providers.
  catalogModelsCache ??= registerOpenAiCompatibleCatalog(
    registerLocalProvider(applyPiModelCompatibility(builtinModels())),
  );
  return catalogModelsCache;
}

function visionModel(provider: string, id: string) {
  const models = catalogModels();
  return provider === CLAUDE_CODE_PROVIDER_ID
    ? claudeCodeModel(id, models)
    : models.getModel(provider, id);
}

/**
 * Mirror Pi's scripted placeholder resolution so vision checks use the same
 * model the runtime will actually call.
 */
export function resolveModelRefForVisionCheck(
  provider: string,
  modelId: string,
): { provider: string; id: string } {
  const normalizedProvider = canonicalPiProviderId(provider.trim());
  const normalizedId = modelId.trim();
  if (normalizedProvider === "scripted" || normalizedId === "scripted") {
    return {
      provider: "openrouter",
      id: process.env.PI_DEFAULT_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL_ID,
    };
  }
  return { provider: normalizedProvider, id: normalizedId };
}

/**
 * Unknown models are treated as text-only. An explicit connection capability
 * override is honored for OpenAI-compatible models. For Codex, `acceptsImages`
 * is the account catalog's answer when a run has one, and is left unused when absent.
 */
export function modelAcceptsImageInput(
  provider: string,
  modelId: string,
  acceptsImages?: boolean,
): boolean {
  const resolved = resolveModelRefForVisionCheck(provider, modelId);
  if (!resolved.provider || !resolved.id) return false;
  if (acceptsImages && resolved.provider === OPENAI_COMPATIBLE_PROVIDER_ID) return true;

  const models = catalogModels();
  let model = visionModel(resolved.provider, resolved.id);
  if (
    !model &&
    resolved.provider !== "openrouter" &&
    resolved.provider !== OPENAI_COMPATIBLE_PROVIDER_ID
  ) {
    model = models.getModel("openrouter", resolved.id);
  }
  model ??= liveModelSibling(models, resolved.provider, resolved.id);
  if (model && resolved.provider === CHATGPT_OAUTH_PROVIDER) {
    model = withLiveImageInput(model, acceptsImages);
  }
  return Boolean(model?.input.includes("image"));
}

export function filterImageReturningComputerTools<T extends { name: string }>(
  tools: T[],
  acceptsImages: boolean,
): T[] {
  if (acceptsImages) return tools;
  return tools.filter((tool) => !IMAGE_RETURNING_COMPUTER_TOOLS.has(tool.name));
}

/** Attachment admission needs proof, unlike conservative screenshot tool gating. */
export function knownModelImageInput(provider: string, modelId: string): boolean | undefined {
  const resolved = resolveModelRefForVisionCheck(provider, modelId);
  if (resolved.provider === OPENAI_COMPATIBLE_PROVIDER_ID) return undefined;
  const model = visionModel(resolved.provider, resolved.id);
  return model ? model.input.includes("image") : undefined;
}

export function runtimeModelAcceptsImages(provider: string, modelId: string): boolean {
  return Boolean(resolveRuntimeModel({ provider, id: modelId }).model?.input.includes("image"));
}
