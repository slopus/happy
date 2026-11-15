import { t } from "@lingui/core/macro";
import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Localize known provider auth hint fallbacks; pass through catalog `authHint` as-is. */
export function localizedProviderHint(entry: ModelCatalogEntry): string {
  if (entry.authHint) return entry.authHint;
  if (entry.signIn !== undefined) return t`Sign in`;
  if (entry.auth === "oauth") return t`Skip or deploy key`;
  return t`API key`;
}

/**
 * Name subscription connections by the plan people pay for. `auth` is how the provider
 * connects: an onboarding option ("sign-in") or a saved credential's kind ("oauth").
 */
export function providerDisplayName(provider: string, name: string, auth?: string): string {
  if (provider === "openai-codex") return t`ChatGPT subscription`;
  if (provider === "anthropic" && (auth === "sign-in" || auth === "oauth")) {
    return t`Claude subscription`;
  }
  return name;
}

/**
 * The provider-row subtitle, shown only when a provider is the exception:
 * sign-in, subscription, or custom-server auth. Plain API-key providers get none.
 */
export function providerRowHint(entry: ModelCatalogEntry): string | null {
  if (!entry.authHint && entry.signIn === undefined && entry.auth !== "oauth") return null;
  return localizedProviderHint(entry);
}
