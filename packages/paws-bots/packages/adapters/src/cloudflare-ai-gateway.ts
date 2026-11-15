import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import type { ModelRoutingField } from "@rakazo/contracts";
import { modelRoutingId } from "@rakazo/contracts";

export const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";

/**
 * A key alone cannot route this provider. The runtime interpolates these ids
 * into the gateway base URL and refuses the provider when either is missing.
 */
export const CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE =
  "Cloudflare AI Gateway needs an account ID and a gateway ID.";

export function isCloudflareAiGatewayProvider(provider: string): boolean {
  return provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
}

export function cloudflareGatewayRouting(input: {
  accountId?: string | null;
  gatewayId?: string | null;
}): { accountId: string; gatewayId: string } | undefined {
  const accountId = modelRoutingId(input.accountId);
  const gatewayId = modelRoutingId(input.gatewayId);
  if (!accountId || !gatewayId) return undefined;
  return { accountId, gatewayId };
}

/** Workers AI routes directly to an account rather than through an AI Gateway. */
export const CLOUDFLARE_WORKERS_AI_PROVIDER_ID = "cloudflare-workers-ai";

export function isCloudflareModelProvider(provider: string): boolean {
  return isCloudflareAiGatewayProvider(provider) || provider === CLOUDFLARE_WORKERS_AI_PROVIDER_ID;
}

/** The ids each provider's catalog entries ask for. */
export function cloudflareRoutingFields(provider: string): ModelRoutingField[] | undefined {
  if (isCloudflareAiGatewayProvider(provider)) return ["accountId", "gatewayId"];
  return provider === CLOUDFLARE_WORKERS_AI_PROVIDER_ID ? ["accountId"] : undefined;
}

export function cloudflareModelConfigMessage(provider: string): string {
  return provider === CLOUDFLARE_WORKERS_AI_PROVIDER_ID
    ? "Cloudflare Workers AI needs an account ID."
    : CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE;
}

export function cloudflareModelRouting(input: {
  provider: string;
  accountId?: string | null;
  gatewayId?: string | null;
}): { accountId: string; gatewayId?: string } | undefined {
  if (isCloudflareAiGatewayProvider(input.provider)) return cloudflareGatewayRouting(input);
  if (input.provider !== CLOUDFLARE_WORKERS_AI_PROVIDER_ID) return undefined;
  const accountId = modelRoutingId(input.accountId);
  return accountId ? { accountId } : undefined;
}

const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID_ENV = "CLOUDFLARE_GATEWAY_ID";

/**
 * Cloudflare requires tenant routing alongside the key. Workers AI needs an
 * account; AI Gateway additionally needs a gateway. Saved routing wins over host env.
 */
export function cloudflareProviderEnv(
  model: Pick<AgentRunModel, "provider" | "accountId" | "gatewayId">,
): Record<string, string> | undefined {
  if (!isCloudflareModelProvider(model.provider)) return undefined;
  const routing = cloudflareModelRouting(model);
  if (!routing) throw new Error(cloudflareModelConfigMessage(model.provider));
  return {
    [CLOUDFLARE_ACCOUNT_ID_ENV]: routing.accountId,
    ...(routing.gatewayId ? { [CLOUDFLARE_GATEWAY_ID_ENV]: routing.gatewayId } : {}),
  };
}

export function withCloudflareAuth(
  model: Pick<AgentRunModel, "provider" | "accountId" | "gatewayId">,
  options: ModelsSimpleStreamOptions | undefined,
): ModelsSimpleStreamOptions | undefined {
  const env = cloudflareProviderEnv(model);
  if (!env) return options;
  return { ...options, env: { ...options?.env, ...env } };
}
