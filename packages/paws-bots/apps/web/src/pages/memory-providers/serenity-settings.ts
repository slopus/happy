/** Example for the empty endpoint field. Not a connection default. */
export const SERENITY_ENDPOINT_PLACEHOLDER = "https://serenity.sire.run/mcp";

export type SerenityEndpointFieldError = "required";

/**
 * The endpoint must be configured. A blank value is not filled with a hosted URL.
 * URL validity stays on the backend (`parseSerenityEndpoint`); the settings overlay
 * shows that error after connect.
 */
export function serenityEndpointError(endpoint: string): SerenityEndpointFieldError | null {
  if (!endpoint.trim()) return "required";
  return null;
}

export function serenityConnectionDraft(input: {
  endpoint: string;
  token: string;
  brainLabel: string;
  allowWrites: boolean;
}):
  | {
      ok: true;
      draft: { settings: Record<string, string>; credentials: Record<string, string> };
    }
  | { ok: false; error: SerenityEndpointFieldError } {
  const error = serenityEndpointError(input.endpoint);
  if (error) return { ok: false, error };
  const brainLabel = input.brainLabel.trim();
  return {
    ok: true,
    draft: {
      settings: {
        endpoint: input.endpoint.trim(),
        allowWrites: input.allowWrites ? "true" : "false",
        ...(brainLabel ? { brainLabel } : {}),
      },
      credentials: { token: input.token.trim() },
    },
  };
}
