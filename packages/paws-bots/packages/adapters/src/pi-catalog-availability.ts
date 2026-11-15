import type { StoredModelSecret } from "./model-secret.js";
import { parseModelSecret } from "./model-secret.js";
import type { PiCatalogAuth, PiCatalogEntry } from "./pi-models.js";
import { listPiCatalog } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";

/** Codex models that ChatGPT Plus/Pro sign-in cannot call. API-key auth still can. */
export const OPENAI_CODEX_CHATGPT_SUBSCRIPTION_EXCLUDED_MODEL_IDS = new Set([
  "gpt-5.3-codex-spark",
]);

export const UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE =
  "This model is not available with your current sign-in. Choose another model in Settings.";

export type ModelCredentialAuthKind = "oauth" | "api_key" | "openai_compatible";

export function modelCredentialAuthKind(secret: StoredModelSecret): ModelCredentialAuthKind {
  if (secret.kind === "oauth") return "oauth";
  if (secret.kind === "openai_compatible") return "openai_compatible";
  return "api_key";
}

export function modelCredentialAuthKindFromPlaintext(plaintext: string): ModelCredentialAuthKind {
  return modelCredentialAuthKind(parseModelSecret(plaintext));
}

/**
 * ChatGPT subscription sign-in cannot call Codex Spark. A stored API key can.
 * Disconnected openai-codex browsing only offers that subscription sign-in, so Spark stays
 * hidden until an API key is stored.
 */
export function catalogModelAvailableForAuth(
  provider: string,
  modelId: string,
  authKind: ModelCredentialAuthKind | "disconnected",
  providerAuth?: PiCatalogAuth,
): boolean {
  if (provider !== CHATGPT_OAUTH_PROVIDER) return true;
  const usesChatGptSubscription =
    authKind === "oauth" ||
    (authKind === "disconnected" && (providerAuth === "oauth" || providerAuth === "both"));
  if (!usesChatGptSubscription) return true;
  return !OPENAI_CODEX_CHATGPT_SUBSCRIPTION_EXCLUDED_MODEL_IDS.has(modelId);
}

/** Catalog entries the given provider credentials can actually call. */
export function listAvailablePiCatalog(
  authByProvider: Readonly<Partial<Record<string, ModelCredentialAuthKind>>> = {},
  authByModel: Readonly<
    Partial<Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>>
  > = {},
): PiCatalogEntry[] {
  return listPiCatalog().filter((entry) =>
    catalogModelAvailableForAuth(
      entry.provider,
      entry.id,
      authByModel[entry.provider]?.[entry.id] ?? authByProvider[entry.provider] ?? "disconnected",
      entry.auth,
    ),
  );
}
