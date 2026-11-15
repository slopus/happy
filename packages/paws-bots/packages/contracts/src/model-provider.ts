export const MODEL_KEY_REJECTED_ERROR = "API key was rejected by the provider.";

export const MODEL_KEY_FORMAT_ERROR = "That doesn't look like an API key. Paste only the key.";

/**
 * A key travels in an HTTP header, which only carries visible ASCII. Pasted prose or a
 * non-Latin character would otherwise save fine and then fail every run inside fetch.
 */
export function assertHeaderSafeApiKey(apiKey: string | undefined): void {
  if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error(MODEL_KEY_FORMAT_ERROR);
}

/** Resolve saved provider IDs after the Pi catalog's Azure rename. */
export function canonicalPiProviderId(provider: string): string {
  return provider === "azure-openai-responses" ? "azure" : provider;
}

/** IDs that may already own credentials for this provider in storage. */
export function storedPiProviderIds(provider: string): string[] {
  const canonical = canonicalPiProviderId(provider);
  return canonical === "azure" ? ["azure", "azure-openai-responses"] : [provider];
}
