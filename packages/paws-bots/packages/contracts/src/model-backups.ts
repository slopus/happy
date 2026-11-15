import type { ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "./model-connections.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./model-connections.js";
import { canonicalPiProviderId } from "./model-provider.js";

export type ConnectedBackupOption = ModelBackupChoice & {
  label: string;
  providerName: string;
  /** The connection serving it; absent for a deployment-managed model. */
  credentialId?: string;
  /** The connection's name, or the provider's for a deployment-managed model. */
  connectionName: string;
};

/** Provider and model only, so a model keeps its effort on whichever connection runs it. */
export function backupChoiceKey(choice: ModelBackupChoice): string {
  return JSON.stringify([canonicalPiProviderId(choice.provider), choice.modelId]);
}

/** One row of a role list: the same model on two connections is two rows. */
export function modelRoleChoiceKey(
  choice: ModelBackupChoice & { credentialId?: string | null },
): string {
  return JSON.stringify([
    canonicalPiProviderId(choice.provider),
    choice.modelId,
    choice.credentialId ?? null,
  ]);
}

/**
 * How a connection is named: its own label, prefixed by the provider when the label
 * does not already say which provider it is (a renamed key or a signed-in account).
 */
export function connectionDisplayName(
  credential: Pick<ModelCredential, "provider" | "label" | "endpointName">,
  providerName: string,
  /** Other names a default label may carry, such as the catalog's "Anthropic" for "Claude subscription". */
  defaultNames: readonly string[] = [],
): string {
  const provider =
    credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
      ? (credential.endpointName ?? providerName)
      : providerName;
  const label = credential.label.trim();
  if (
    !label ||
    label === credential.provider ||
    label === providerName ||
    defaultNames.includes(label)
  )
    return provider;
  if (label.toLowerCase().startsWith(provider.toLowerCase())) return label;
  return `${provider} (${label})`;
}

/**
 * "Model (OpenRouter)", folding a named connection in so it reads "Model (OpenRouter, Work)"
 * instead of nesting brackets.
 */
export function withConnectionName(label: string, connection: string): string {
  const named = connection.match(/^(.+) \((.+)\)$/);
  return `${label} (${named ? `${named[1]}, ${named[2]}` : connection})`;
}

/**
 * Models a role can pick, grouped by the connection that runs them: every connection of a
 * provider offers that provider's models, and deployment-managed models need none.
 */
export function connectedBackupOptions(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[],
  /** Screen work needs a model that accepts images, on a connection of the member's own. */
  computerUse = false,
): ConnectedBackupOption[] {
  const connections = new Map<string, ModelCredential[]>();
  for (const credential of credentials) {
    const provider = canonicalPiProviderId(credential.provider);
    connections.set(provider, [...(connections.get(provider) ?? []), credential]);
  }
  const entries = new Map<string, ModelCatalogEntry[]>();
  for (const entry of catalog) {
    if (entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID || entry.placeholder) continue;
    const provider = canonicalPiProviderId(entry.provider);
    entries.set(provider, [...(entries.get(provider) ?? []), entry]);
  }
  const options: ConnectedBackupOption[] = [];
  for (const [provider, models] of entries) {
    const owners = connections.get(provider) ?? [];
    const option = (entry: ModelCatalogEntry, connection?: ModelCredential) => {
      const providerName = entry.providerName ?? entry.provider;
      return {
        provider: entry.provider,
        modelId: entry.id,
        label: entry.label,
        providerName,
        ...(connection ? { credentialId: connection.id } : {}),
        connectionName: connection ? connectionDisplayName(connection, providerName) : providerName,
      };
    };
    if (owners.length === 0) {
      if (!computerUse)
        options.push(...models.filter((entry) => entry.managed).map((entry) => option(entry)));
      continue;
    }
    for (const connection of owners)
      options.push(
        ...models
          .filter((entry) => !entry.credentialIds || entry.credentialIds.includes(connection.id))
          .map((entry) => option(entry, connection)),
      );
  }
  for (const credential of credentials) {
    if (credential.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) continue;
    const seen = new Set<string>();
    for (const raw of credential.enabledModelIds ?? [credential.modelId ?? ""]) {
      const modelId = raw.trim();
      if (!modelId || seen.has(modelId)) continue;
      if (computerUse && !credential.visionModelIds?.includes(modelId)) continue;
      seen.add(modelId);
      const entry = catalog.find(
        (candidate) =>
          candidate.provider === OPENAI_COMPATIBLE_PROVIDER_ID && candidate.id === modelId,
      );
      const providerName = entry?.providerName ?? OPENAI_COMPATIBLE_PROVIDER_ID;
      options.push({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId,
        label: entry?.label ?? modelId,
        providerName,
        credentialId: credential.id,
        connectionName: connectionDisplayName(credential, providerName),
      });
    }
  }
  return options;
}

export function moveBackupChoice(
  choices: ModelBackupChoice[],
  index: number,
  direction: -1 | 1,
): ModelBackupChoice[] {
  const target = index + direction;
  if (index < 0 || index >= choices.length || target < 0 || target >= choices.length) {
    return choices;
  }
  const next = [...choices];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function sameBackupChoices(left: ModelBackupChoice[], right: ModelBackupChoice[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (choice, index) =>
        canonicalPiProviderId(choice.provider) ===
          canonicalPiProviderId(right[index]?.provider ?? "") &&
        choice.modelId === right[index]?.modelId,
    )
  );
}
