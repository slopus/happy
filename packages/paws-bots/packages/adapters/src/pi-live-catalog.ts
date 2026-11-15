import { createHash } from "node:crypto";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SecretStore } from "@rakazo/adapter-kit";
import { canonicalPiProviderId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { parseModelSecret } from "./model-secret.js";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import { LiveCatalogCache, liveModelCatalogEnabled } from "./pi-live-cache.js";
import { isChatModelId, liveModelSibling } from "./pi-live-model.js";
import type { PiCatalogEntry } from "./pi-models.js";
import {
  catalogModelLabel,
  catalogProviderProbeBaseUrl,
  isRecommendedCatalogModel,
  listPiCatalog,
  probeCatalogProviderModels,
} from "./pi-models.js";

/** Credential governing each provider/model slot, shared with the run selection path. */
export type CatalogSpaceAuth = {
  byProvider: Partial<Record<string, ModelCredentialAuthKind>>;
  byModel: Partial<
    Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>
  >;
  secretIdByProvider?: Partial<Record<string, string>>;
  secretIdByModel?: Partial<Record<string, Partial<Record<string, string>>>>;
};

/** Shared overlay primitive: keep registry order and append additions within their provider. */
export function overlayLiveCatalog(
  base: readonly PiCatalogEntry[],
  candidates: readonly PiCatalogEntry[],
  resolve: (entry: PiCatalogEntry) => PiCatalogEntry | undefined,
  additions: readonly PiCatalogEntry[] = [],
): PiCatalogEntry[] {
  const present = new Set(base);
  const out: PiCatalogEntry[] = [];
  const lastIndex = new Map(candidates.map((entry, index) => [entry.provider, index]));
  candidates.forEach((entry, index) => {
    const resolved = resolve(entry);
    if (resolved) out.push(resolved);
    else if (present.has(entry)) out.push(entry);
    if (lastIndex.get(entry.provider) === index) {
      out.push(
        ...additions
          .filter((addition) => addition.provider === entry.provider)
          .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
      );
    }
  });
  return out;
}

export function trustedProviderModels(provider: string, ids: readonly string[]): boolean {
  const bundled = listPiCatalog().filter((entry) => entry.provider === provider);
  const live = new Set(ids);
  return (
    live.size > 0 &&
    bundled.filter((entry) => live.has(entry.id)).length >= Math.ceil(bundled.length / 4)
  );
}

const siblingModels = builtinModels();

export function liveCatalogEntry(provider: string, id: string): PiCatalogEntry | undefined {
  provider = canonicalPiProviderId(provider);
  const entry = listPiCatalog().find((entry) => entry.provider === provider);
  const model = liveModelSibling(siblingModels, provider, id);
  if (!entry || !model) return undefined;
  return {
    ...entry,
    id,
    recommended: isRecommendedCatalogModel(provider, id),
    label: catalogModelLabel(id),
    live: true,
    reasoning: model.reasoning,
    thinkingLevels: ["off"],
    images: model.input.includes("image"),
  };
}

/** Credential slots, including per-model overrides, use the same selection as execution. */
export function applyProviderLiveCatalog(
  base: readonly PiCatalogEntry[],
  auth: CatalogSpaceAuth,
  live: ReadonlyMap<string, readonly string[]>,
  selected: ReadonlySet<string> = new Set(),
): PiCatalogEntry[] {
  const trusted = new Map<string, Set<string> | undefined>();
  const effective = (provider: string, id: string) => {
    const override = auth.byModel[provider]?.[id];
    const kind = override ?? auth.byProvider[provider];
    const secret =
      override === undefined
        ? auth.secretIdByProvider?.[provider]
        : auth.secretIdByModel?.[provider]?.[id];
    const ids = kind === "api_key" && secret ? live.get(secret) : undefined;
    if (!ids || !secret) return undefined;
    const key = `${provider}:${secret}`;
    if (!trusted.has(key))
      trusted.set(key, trustedProviderModels(provider, ids) ? new Set(ids) : undefined);
    return trusted.get(key);
  };
  const additions: PiCatalogEntry[] = [];
  for (const provider of new Set(base.map((entry) => entry.provider))) {
    if (!catalogProviderProbeBaseUrl(provider)) continue;
    const ids = new Set([
      ...(live.get(auth.secretIdByProvider?.[provider] ?? "") ?? []),
      ...Object.values(auth.secretIdByModel?.[provider] ?? {}).flatMap(
        (secret) => live.get(secret ?? "") ?? [],
      ),
    ]);
    for (const choice of selected) {
      if (choice.startsWith(`${provider}:`)) ids.add(choice.slice(provider.length + 1));
    }
    for (const id of ids) {
      if (
        (!effective(provider, id)?.has(id) && !selected.has(`${provider}:${id}`)) ||
        base.some((entry) => entry.provider === provider && entry.id === id) ||
        !isChatModelId(id)
      )
        continue;
      if (!effective(provider, id)) continue;
      const entry = liveCatalogEntry(provider, id);
      if (entry) additions.push(entry);
    }
  }
  // Explicitly filter retired entries before the overlay; absence otherwise means fallback.
  const retained = base.filter((entry) => {
    if (!entry.catalogProbe) return true;
    const ids = effective(entry.provider, entry.id);
    return !ids || ids.has(entry.id) || selected.has(`${entry.provider}:${entry.id}`);
  });
  return overlayLiveCatalog(retained, retained, (entry) => entry, additions);
}

export type ProviderCatalogCredential = {
  provider: string;
  secretId: string;
  version: string;
  apiKey: () => Promise<string | undefined>;
};

/** API-key policy over the same cache lifecycle as Codex. No raw key enters cache identity. */
export class ProviderCatalogCache {
  private readonly cache: LiveCatalogCache<string>;
  private readonly probe: typeof probeCatalogProviderModels;
  private readonly enabledOverride: boolean | undefined;
  get enabled(): boolean {
    return this.enabledOverride ?? liveModelCatalogEnabled();
  }
  constructor(
    options: {
      enabled?: boolean;
      probe?: typeof probeCatalogProviderModels;
      now?: () => number;
      ttlMs?: number;
      failureTtlMs?: number;
      waitMs?: number;
      deadlineMs?: number;
      maxEntries?: number;
    } = {},
  ) {
    this.enabledOverride = options.enabled;
    this.probe = options.probe ?? probeCatalogProviderModels;
    this.cache = new LiveCatalogCache({
      now: options.now,
      ttlMs: options.ttlMs ?? 6 * 60 * 60_000,
      failureTtlMs: options.failureTtlMs ?? 10 * 60_000,
      waitMs: options.waitMs ?? 1_500,
      deadlineMs: options.deadlineMs ?? 5_000,
      staleMaxAgeMs: 24 * 60 * 60_000,
      maxEntries: options.maxEntries ?? 256,
    });
  }
  invalidate(provider: string): void {
    this.cache.invalidate(`${provider}:`);
  }
  read(credential: ProviderCatalogCredential, waitMs?: number): Promise<string[] | undefined> {
    if (!this.enabled || !catalogProviderProbeBaseUrl(credential.provider))
      return Promise.resolve(undefined);
    return this.cache.read(
      `${credential.provider}:${credential.secretId}:${credential.version}`,
      async (signal) => {
        const apiKey = await credential.apiKey();
        if (!apiKey || signal.aborted) return { attempted: true, models: undefined };
        const ids = await this.probe({ provider: credential.provider, apiKey }, undefined, signal);
        return {
          attempted: true,
          models: trustedProviderModels(credential.provider, ids) ? ids : undefined,
        };
      },
      waitMs,
    );
  }
}

export async function providerLiveCatalogsForSpace(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  scope: { userId: string; spaceId: string },
  auth: CatalogSpaceAuth,
  cache: ProviderCatalogCache,
): Promise<Map<string, string[]>> {
  if (!cache.enabled) return new Map();
  const slots = new Map<string, string>();
  for (const provider of Object.keys(auth.byProvider)) {
    if (auth.byProvider[provider] === "api_key" && catalogProviderProbeBaseUrl(provider)) {
      const id = auth.secretIdByProvider?.[provider];
      if (id) slots.set(id, provider);
    }
  }
  for (const [provider, models] of Object.entries(auth.byModel)) {
    if (!catalogProviderProbeBaseUrl(provider)) continue;
    for (const [model, kind] of Object.entries(models ?? {})) {
      const id = auth.secretIdByModel?.[provider]?.[model];
      if (kind === "api_key" && id) slots.set(id, provider);
    }
  }
  const out = new Map<string, string[]>();
  if (!slots.size) return out;
  const rows = await prisma.secret.findMany({
    where: { id: { in: [...slots.keys()] }, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  await Promise.all(
    rows.map(async (row) => {
      const provider = slots.get(row.id);
      if (!provider) return;
      const ids = await readSecretCatalog(cache, secrets, provider, row);
      if (ids) out.set(row.id, ids);
    }),
  );
  return out;
}

export const providerCatalogCache = new ProviderCatalogCache();

/** Cache identity is the secret id plus a ciphertext hash; the key is decrypted only to probe. */
function readSecretCatalog(
  cache: ProviderCatalogCache,
  secrets: Pick<SecretStore, "load">,
  provider: string,
  row: { id: string; ciphertext: string },
): Promise<string[] | undefined> {
  return cache.read({
    provider,
    secretId: row.id,
    version: createHash("sha256").update(row.ciphertext).digest("hex"),
    apiKey: async () => {
      const secret = parseModelSecret(await secrets.load(row.ciphertext, row.id));
      return secret.kind === "api_key" ? secret.key : undefined;
    },
  });
}

/**
 * Rows one request reads again for every model it checks: each connection's secret and the
 * account's saved choices. Make one per request; never keep it across requests.
 */
export type CatalogReads = Map<string, Promise<unknown>>;

export function readOnce<T>(
  reads: CatalogReads | undefined,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!reads) return read();
  let value = reads.get(key) as Promise<T> | undefined;
  if (!value) {
    value = read();
    reads.set(key, value);
  }
  return value;
}

/** Validation reads the exact credential chosen for the user/model, through the listing cache. */
export async function providerLiveListsModel(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  cache = providerCatalogCache,
  reads?: CatalogReads,
): Promise<boolean> {
  provider = canonicalPiProviderId(provider);
  if (
    !cache.enabled ||
    !catalogProviderProbeBaseUrl(provider) ||
    !liveCatalogEntry(provider, modelId)
  )
    return false;
  const row = await readOnce(reads, `secret:${userId}:${secretId}`, () =>
    prisma.secret.findFirst({
      where: { id: secretId, userId, spaceId: null },
      select: { id: true, ciphertext: true },
    }),
  );
  if (!row) return false;
  const ids = await readSecretCatalog(cache, secrets, provider, row);
  if (!ids) return false;
  if (ids.includes(modelId)) return true;
  const selections = await readOnce(reads, `selections:${userId}`, () =>
    savedCatalogSelections(prisma, userId),
  );
  return selections.has(`${provider}:${modelId}`);
}

/** Saved selections, the account's and every Space's, survive retirement filtering. */
export async function savedCatalogSelections(
  prisma: PrismaClient,
  userId: string,
): Promise<Set<string>> {
  const [preferences, bots, routines, accountRoles, spaceRoles, settings] = await Promise.all([
    prisma.userModelPreference.findMany({
      where: { userId },
      select: { modelId: true, credential: { select: { provider: true } } },
    }),
    prisma.bot.findMany({ where: { userId }, select: { modelProvider: true, modelId: true } }),
    prisma.routine.findMany({ where: { userId }, select: { modelProvider: true, modelId: true } }),
    prisma.userModelRoleChoice.findMany({
      where: { userId },
      select: { provider: true, modelId: true },
    }),
    // A Space's own models count only while it overrides the account's.
    prisma.spaceModelRoleChoice.findMany({
      where: { userId, spaceMember: { settingOverrides: { some: { setting: "models" } } } },
      select: { provider: true, modelId: true },
    }),
    prisma.deploymentSettings.findFirst({
      select: { defaultModelProvider: true, defaultModelId: true },
    }),
  ]);
  return new Set([
    ...preferences.map((p) => `${canonicalPiProviderId(p.credential.provider)}:${p.modelId}`),
    ...bots.map(
      (p) => `${p.modelProvider ? canonicalPiProviderId(p.modelProvider) : ""}:${p.modelId}`,
    ),
    ...routines.map(
      (p) => `${p.modelProvider ? canonicalPiProviderId(p.modelProvider) : ""}:${p.modelId}`,
    ),
    ...[...accountRoles, ...spaceRoles].map(
      (p) => `${canonicalPiProviderId(p.provider)}:${p.modelId}`,
    ),
    ...(settings ? [`${settings.defaultModelProvider}:${settings.defaultModelId}`] : []),
  ]);
}
