import type { VoiceCatalogEntry, VoiceCredential } from "./domain.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./model-connections.js";

/**
 * What the voice settings form offers for a provider. Until connected, the account's model
 * connection can stand in for a key (`keyOptional`); once linked there is no key to show or
 * replace (`linked`).
 */
export function voiceConnectionForm(input: {
  entry: Pick<VoiceCatalogEntry, "id" | "keyless" | "modelConnection"> | undefined;
  credential: Pick<VoiceCredential, "hasKey"> | undefined;
  apiKey: string;
  baseUrl: string;
}): { keyOptional: boolean; linked: boolean; canConnect: boolean } {
  const keyOptional = Boolean(input.entry?.modelConnection) && !input.credential;
  const typedKey = input.apiKey.trim();
  const canConnect =
    Boolean(input.entry?.keyless) ||
    (input.entry?.id === OPENAI_COMPATIBLE_PROVIDER_ID
      ? Boolean(input.baseUrl.trim())
      : typedKey.length >= 8 || (keyOptional && !typedKey));
  return { keyOptional, linked: input.credential?.hasKey === false, canConnect };
}
