import type { SecretStore } from "@rakazo/adapter-kit";
import type { PageShareSecret } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Deleting a page link's secret row does not reach a remote secret provider, so once that delete
 * commits the sealed token is removed from the store as well. Best effort: the link is already
 * dead, since its row and the hash that opened it are gone, so a failure is only logged.
 */
export async function forgetPageShareSecrets(
  store: Pick<SecretStore, "delete">,
  secrets: readonly PageShareSecret[],
): Promise<void> {
  const results = await Promise.allSettled(
    secrets.map((secret) =>
      store.delete(secret.ciphertext, {
        recordId: secret.id,
        signal: AbortSignal.timeout(10_000),
      }),
    ),
  );
  for (const result of results) {
    if (result.status === "rejected") getLogger().error("page link secret cleanup", result.reason);
  }
}
