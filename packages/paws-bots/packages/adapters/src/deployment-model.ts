import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelUsageLookup } from "@rakazo/adapter-kit";
import {
  CLAUDE_CODE_CREDENTIAL_SOURCE,
  CLAUDE_CODE_PROVIDER_ID,
} from "./cli-models/claude-code/provider-id.js";
import { OpenRouterUsageLookup } from "./openrouter-usage.js";
import { LOCAL_PROVIDER_ID, localModelIds } from "./pi-local-provider-id.js";

export const DEFAULT_OPENROUTER_MODEL_ID = "anthropic/claude-haiku-5.5";

/**
 * What Pi reports for a provider that authenticates from the host instead of a key: an AWS
 * profile or task role for Amazon Bedrock, Application Default Credentials for Vertex.
 */
const HOST_CREDENTIALS = "<authenticated>";

/** What a provider's host credentials are, for telling a user what a deployment runs on. */
const HOST_CREDENTIAL_SOURCES: Record<string, string> = {
  "amazon-bedrock": "AWS IAM",
  "google-vertex": "Google Cloud",
  [CLAUDE_CODE_PROVIDER_ID]: CLAUDE_CODE_CREDENTIAL_SOURCE,
};

/** The kind of host credentials a provider authenticates with, e.g. "AWS IAM". */
export function hostCredentialSource(provider: string): string {
  return HOST_CREDENTIAL_SOURCES[provider] ?? "host";
}

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Keyless host authentication requires explicit opt-in and a model id. Bedrock resolves
 * its credential chain (including instance roles) at request time; local models must be
 * declared by the operator; the Claude Code CLI uses the operator's own sign-in on this host;
 * other providers must report host credentials in the process environment. Host credentials
 * never become `key`.
 *
 * Vendor env names and model ids live here, in the adapter layer, not in core.
 */
export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  // An unknown provider gets no key rather than another vendor's.
  const keys: Record<string, string | undefined> = {
    openrouter: env.OPENROUTER_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
  };
  const models: Record<string, string> = {
    openrouter: DEFAULT_OPENROUTER_MODEL_ID,
    anthropic: "claude-sonnet-5",
    deepseek: "deepseek-flash",
  };
  const explicitModel = env.PI_DEFAULT_MODEL?.trim();
  const key = keys[provider];
  const hostCredentials =
    !key &&
    Boolean(explicitModel) &&
    env.PI_DEFAULT_CREDENTIALS?.trim() === "host" &&
    // Bedrock also resolves EC2 instance roles through IMDS at request time.
    (provider === LOCAL_PROVIDER_ID
      ? localModelIds(env).includes(explicitModel!)
      : provider === CLAUDE_CODE_PROVIDER_ID ||
        provider === "amazon-bedrock" ||
        getEnvApiKey(provider) === HOST_CREDENTIALS);
  return {
    provider,
    model: explicitModel || models[provider] || models.openrouter!,
    key,
    configured: Boolean(key) || hostCredentials,
    hostCredentials,
  };
}

export function deploymentModelUsageLookup(): ModelUsageLookup | undefined {
  const model = resolveDeploymentModel();
  return model.provider === "openrouter" && model.key
    ? new OpenRouterUsageLookup(model.key)
    : undefined;
}
