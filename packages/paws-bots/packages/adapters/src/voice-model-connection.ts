import type { SecretStore } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import { resolveStoredModelAuth, withModelCredentialLock } from "./model-credential-refresh.js";
import { isRetiredModelCredentialError } from "./pi-oauth.js";
import { voiceCatalogEntry } from "./voice-factory.js";

/**
 * A voice connection's secret when it authenticates with the account's model connection to the
 * same provider instead of a key of its own. It holds no token: each request reads the model
 * connection, so a refresh or reconnect there carries over.
 */
export const MODEL_CONNECTION_VOICE_SECRET = JSON.stringify({ kind: "model_connection" });

export function isModelConnectionVoiceSecret(plaintext: string): boolean {
  return plaintext === MODEL_CONNECTION_VOICE_SECRET;
}

export type VoiceKeyDeps = {
  prisma: Pick<
    PrismaClient,
    "$transaction" | "secret" | "userModelCredential" | "userModelPreference"
  >;
  secretStore: Pick<SecretStore, "load" | "put" | "delete">;
};

/**
 * The bearer a voice adapter sends: the stored key, or a current one from the account's model
 * connection to the provider, refreshed and retired under the same lock a model run uses.
 */
export async function resolveVoiceKey(
  deps: VoiceKeyDeps,
  scope: { userId: string; spaceId: string },
  provider: string,
  plaintext: string,
  signal?: AbortSignal,
): Promise<string> {
  // Only a provider the catalog lets use the model connection may; elsewhere it is a pasted key.
  if (!isModelConnectionVoiceSecret(plaintext) || !voiceCatalogEntry(provider)?.modelConnection) {
    return plaintext;
  }
  const missing = () =>
    new VoiceAccountError(
      undefined,
      `Connect ${voiceCatalogEntry(provider)?.name ?? provider} in Models settings.`,
    );
  const credential = await findModelCredential(deps.prisma, { userId: scope.userId }, provider);
  if (!credential) throw missing();
  return withModelCredentialLock(credential.secretId, async () => {
    const row = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    });
    if (!row) throw missing();
    const stored = await deps.secretStore.load(row.ciphertext, row.id);
    try {
      const { apiKey } = await resolveStoredModelAuth(
        deps.prisma,
        deps.secretStore,
        scope,
        credential,
        stored,
        provider,
        { signal },
      );
      if (!apiKey) throw missing();
      return apiKey;
    } catch (error) {
      if (isRetiredModelCredentialError(error)) throw missing();
      throw error;
    }
  });
}
