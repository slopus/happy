import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  selectCompatibleModelCredential,
  usableModelId,
} from "@rakazo/contracts";
import { MODEL_UNPRICED_FOR_CREDITS_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  chooseModelCredential,
  findModelCredential,
  findModelCredentialById,
  GUEST_ROLE,
  modelCredentialProviderFilter,
  organizationForMember,
} from "@rakazo/db";
import { resolveDeploymentModel } from "./deployment-model.js";
import { modelCredentialDto } from "./model-connect.js";
import type { StoredModelSecret } from "./model-secret.js";
import { parseModelSecret } from "./model-secret.js";
import { compatibleModelSeesImages, modelAcceptsImageInput } from "./model-vision.js";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import {
  catalogModelAvailableForAuth,
  listAvailablePiCatalog,
  modelCredentialAuthKindFromPlaintext,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "./pi-catalog-availability.js";
import type { CodexLiveCatalog, CodexLiveReadOptions } from "./pi-codex-catalog.js";
import { codexLiveListsModel } from "./pi-codex-catalog.js";
import type { CatalogReads } from "./pi-live-catalog.js";
import { liveCatalogEntry, providerLiveListsModel, readOnce } from "./pi-live-catalog.js";
import {
  creditsCanPriceModel,
  listPiCatalog,
  offeredCatalog,
  scriptedCatalogEntry,
} from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

export type ModelCredential = Awaited<ReturnType<typeof findModelCredential>>;

export function isCatalogModelChoice(provider: string, modelId: string) {
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === canonicalPiProviderId(provider) && item.id === modelId,
  );
}

async function credentialLiveListsModel(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  codex?: CodexLiveCatalog,
  reads?: CatalogReads,
): Promise<boolean> {
  if (
    await providerLiveListsModel(
      prisma,
      secrets,
      userId,
      secretId,
      provider,
      modelId,
      undefined,
      reads,
    )
  )
    return true;
  if (provider !== "openai-codex" || !codex || !liveCatalogEntry(provider, modelId)) return false;
  const secret = await loadModelSecret(prisma, secrets, userId, secretId, reads);
  return secret ? codexLiveListsModel(codex, userId, secret, modelId) : false;
}

/**
 * Whether this connection can run the model: a bundled model its sign-in or key can call,
 * or one its own live catalog lists. Two accounts of one provider can differ here.
 */
export async function connectionServesModel(
  deps: {
    prisma: PrismaClient;
    secretStore: Pick<SecretStore, "load">;
    codexCatalog?: CodexLiveCatalog;
    reads?: CatalogReads;
  },
  userId: string,
  credential: { secretId: string },
  provider: string,
  modelId: string,
): Promise<boolean> {
  if (isCatalogModelChoice(provider, modelId)) {
    if (!modelAuthIsRestricted(provider, modelId)) return true;
    return !(await validateStoredModelAuth(
      deps.prisma,
      deps.secretStore,
      userId,
      credential.secretId,
      provider,
      modelId,
      deps.codexCatalog,
      undefined,
      deps.reads,
    ));
  }
  // Models no live catalog lists, such as decision models, are not tied to an account.
  if (!liveCatalogEntry(provider, modelId)) return true;
  return credentialLiveListsModel(
    deps.prisma,
    deps.secretStore,
    userId,
    credential.secretId,
    provider,
    modelId,
    deps.codexCatalog,
    deps.reads,
  );
}

export function defaultCatalogModelId(
  provider: string,
  credentialPlaintext?: string,
): string | null {
  const authKind = credentialPlaintext
    ? modelCredentialAuthKindFromPlaintext(credentialPlaintext)
    : "disconnected";
  const authByProvider: Partial<Record<string, ModelCredentialAuthKind>> =
    authKind === "disconnected" ? {} : { [provider]: authKind };
  const entries = offeredCatalog(listAvailablePiCatalog(authByProvider)).filter(
    (item) => item.provider === canonicalPiProviderId(provider),
  );
  return usableModelId((entries.find((item) => item.recommended) ?? entries[0])?.id);
}

/** A run pinned to a provider the user has no connection for. */
export const PINNED_PROVIDER_NOT_CONNECTED = "Connect that model provider first";

export class UnavailableModelForAuthError extends Error {
  constructor(message = UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE) {
    super(message);
    this.name = "UnavailableModelForAuthError";
  }
}

export type SpaceCatalogAuth = {
  managedProvider?: string;
  byProvider: Partial<Record<string, ModelCredentialAuthKind>>;
  /** Model-specific kinds. `"disconnected"` blocks the provider fallback. */
  byModel: Partial<
    Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>
  >;
  /**
   * Secret id of the credential governing each provider/model slot, so
   * per-account lookups (like the live Codex catalog) stay keyed to the
   * credential that would actually serve the model.
   */
  secretIdByProvider: Partial<Record<string, string>>;
  secretIdByModel: Partial<Record<string, Partial<Record<string, string>>>>;
};

/** Whether this space would run the model on Rakazo credits rather than a member's own connection. */
export function runsOnHostedCredits(
  auth: SpaceCatalogAuth,
  entry: { provider: string; id: string },
): boolean {
  return (
    entry.provider === auth.managedProvider &&
    !auth.secretIdByModel[entry.provider]?.[entry.id] &&
    !auth.secretIdByProvider[entry.provider]
  );
}

/** Credits refuse a model they cannot price; the member's own connection still runs it. */
export function spaceCanRunCatalogModel(
  auth: SpaceCatalogAuth,
  entry: { provider: string; id: string },
): boolean {
  return !runsOnHostedCredits(auth, entry) || creditsCanPriceModel(entry);
}

/**
 * Auth kinds for the credentials `chooseModelCredential` would select in this space.
 * Each catalog model uses the preference that owns that model id, then the provider
 * preference, then the newest account credential. An unreadable selected secret stays
 * disconnected instead of falling through to an older key.
 */
export async function modelCredentialAuthKindsForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: Pick<Actor, "userId" | "spaceId">,
  hostedProvider?: string,
): Promise<SpaceCatalogAuth> {
  const hosted = hostedProvider && (await hasHostedModelCredits(prisma, scope, hostedProvider));
  const [credentials, preferences] = await Promise.all([
    prisma.userModelCredential.findMany({
      where: { userId: scope.userId },
      select: {
        id: true,
        provider: true,
        secretId: true,
        updatedAt: true,
        createdAt: true,
      },
    }),
    prisma.userModelPreference.findMany({
      where: { userId: scope.userId },
      select: {
        modelId: true,
        thinkingLevel: true,
        updatedAt: true,
        credential: {
          select: {
            id: true,
            provider: true,
            secretId: true,
            updatedAt: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);
  const connectedProviders = new Set([
    ...credentials.map((credential) => canonicalPiProviderId(credential.provider)),
    ...preferences.map((preference) => canonicalPiProviderId(preference.credential.provider)),
  ]);
  const selections: Array<{
    provider: string;
    modelId: string;
    secretId: string;
    modelSpecific: boolean;
  }> = [];
  const slots = [
    ...listPiCatalog(),
    ...preferences.flatMap((preference) =>
      preference.modelId
        ? [
            {
              provider: canonicalPiProviderId(preference.credential.provider),
              id: preference.modelId,
            },
          ]
        : [],
    ),
  ];
  for (const entry of slots) {
    if (!connectedProviders.has(entry.provider) || (hosted && entry.provider === hostedProvider))
      continue;
    const choice = chooseModelCredential({
      provider: entry.provider,
      modelId: entry.id,
      preferences,
      credentials,
    });
    if (!choice) continue;
    const secretId =
      choice.source === "preference"
        ? choice.preference.credential.secretId
        : choice.credential.secretId;
    const requestedModelId = usableModelId(entry.id);
    selections.push({
      provider: entry.provider,
      modelId: entry.id,
      secretId,
      modelSpecific:
        choice.source === "preference" &&
        requestedModelId !== null &&
        choice.preference.modelId === requestedModelId,
    });
  }
  const empty: SpaceCatalogAuth = {
    managedProvider: hosted ? hostedProvider : undefined,
    byProvider: {},
    byModel: {},
    secretIdByProvider: {},
    secretIdByModel: {},
  };
  if (hosted && hostedProvider) empty.byProvider[hostedProvider] = "api_key";
  if (selections.length === 0) return empty;

  const secrets = await prisma.secret.findMany({
    where: {
      id: { in: [...new Set(selections.map((selection) => selection.secretId))] },
      userId: scope.userId,
      spaceId: null,
    },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  // Every catalog model of a provider shares one secret; load each once per operation.
  const kindBySecretId = new Map<string, Promise<ModelCredentialAuthKind | undefined>>();
  const decryptKind = async (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    const ciphertext = ciphertextById.get(secretId);
    if (!ciphertext) return undefined;
    try {
      return modelCredentialAuthKindFromPlaintext(await secretStore.load(ciphertext, secretId));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return undefined;
    }
  };
  const readKind = (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    if (!kindBySecretId.has(secretId)) kindBySecretId.set(secretId, decryptKind(secretId));
    return kindBySecretId.get(secretId)!;
  };

  const auth = empty;
  for (const selection of selections) {
    const kind = await readKind(selection.secretId);
    if (selection.modelSpecific) {
      const models = auth.byModel[selection.provider] ?? {};
      models[selection.modelId] = kind ?? "disconnected";
      auth.byModel[selection.provider] = models;
      const secrets = auth.secretIdByModel[selection.provider] ?? {};
      secrets[selection.modelId] = selection.secretId;
      auth.secretIdByModel[selection.provider] = secrets;
      continue;
    }
    if (kind) auth.byProvider[selection.provider] = kind;
    auth.secretIdByProvider[selection.provider] = selection.secretId;
  }
  if (hosted && hostedProvider && !auth.byProvider[hostedProvider])
    auth.byProvider[hostedProvider] = "api_key";
  return auth;
}

export function validateModelAuthAvailability(
  provider: string,
  modelId: string,
  credentialPlaintext?: string,
): string | undefined {
  if (!credentialPlaintext) return undefined;
  const authKind = modelCredentialAuthKindFromPlaintext(credentialPlaintext);
  const catalogEntry = listPiCatalog().find(
    (item) => item.provider === canonicalPiProviderId(provider) && item.id === modelId,
  );
  if (!catalogModelAvailableForAuth(provider, modelId, authKind, catalogEntry?.auth)) {
    return UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE;
  }
  return undefined;
}

function modelAuthIsRestricted(provider: string, modelId: string): boolean {
  const entry = listPiCatalog().find(
    (item) => item.provider === canonicalPiProviderId(provider) && item.id === modelId,
  );
  if (!entry) return false;
  return (["oauth", "api_key", "openai_compatible", "disconnected"] as const).some(
    (kind) => !catalogModelAvailableForAuth(provider, modelId, kind, entry.auth),
  );
}

/**
 * Ready credential to save as the space default.
 * The first ready credential in `orderedIds` wins, unless it already stores an
 * auth-restricted model and another ready credential can take the new default.
 */
export function selectDefaultCredentialId(input: {
  provider: string;
  modelId: string;
  orderedIds: readonly string[];
  readyIds: readonly string[];
  savedModelId: (credentialId: string) => string | null | undefined;
}): string | undefined {
  const ready = new Set(input.readyIds);
  const preferred = input.orderedIds.find((id) => ready.has(id));
  if (!preferred) return undefined;
  const saved = usableModelId(input.savedModelId(preferred));
  const requested = usableModelId(input.modelId);
  if (!saved || saved === requested) return preferred;
  const alternate = input.orderedIds.find((id) => id !== preferred && ready.has(id));
  if (!alternate || !modelAuthIsRestricted(input.provider, saved)) return preferred;
  return alternate;
}

export type StoredModelAuthRead =
  | { status: "ready" }
  | { status: "unreadable" }
  | { status: "rejected"; message: string };

export type LoadedModelSecret =
  | { status: "missing" }
  | { status: "unreadable"; ciphertext: string }
  | { status: "loaded"; ciphertext: string; plaintext: string };

/** Whether a model on a member's connection accepts image input, as that connection declares it. */
export async function connectedModelSeesImages(
  deps: { prisma: Pick<PrismaClient, "secret">; secretStore: Pick<SecretStore, "load"> },
  userId: string,
  provider: string,
  modelId: string,
  credential: ModelCredential,
  catalogImages?: boolean,
): Promise<boolean> {
  if (canonicalPiProviderId(provider) !== OPENAI_COMPATIBLE_PROVIDER_ID)
    return modelAcceptsImageInput(provider, modelId, catalogImages);
  if (!credential) return false;
  const stored = await loadStoredModelSecret(
    deps.prisma,
    deps.secretStore,
    userId,
    credential.secretId,
  );
  if (stored.status !== "loaded") return false;
  try {
    const secret = parseModelSecret(stored.plaintext);
    return (
      secret.kind === "openai_compatible" && compatibleModelSeesImages(credential, secret, modelId)
    );
  } catch {
    return false;
  }
}

/**
 * Read a user's account-wide model secret. A missing row or an undecryptable ciphertext is
 * reported, not thrown; a store outage (`SecretStoreUnavailableError`) propagates. With
 * `reads`, one request reads and decrypts each secret once.
 */
export function loadStoredModelSecret(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  reads?: CatalogReads,
): Promise<LoadedModelSecret> {
  return readOnce<LoadedModelSecret>(reads, `model-secret:${userId}:${secretId}`, async () => {
    const secret = await readOnce(reads, `secret:${userId}:${secretId}`, () =>
      prisma.secret.findFirst({
        where: { id: secretId, userId, spaceId: null },
        select: { id: true, ciphertext: true },
      }),
    );
    if (!secret) return { status: "missing" };
    try {
      const plaintext = await secretStore.load(secret.ciphertext, secret.id);
      return { status: "loaded", ciphertext: secret.ciphertext, plaintext };
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return { status: "unreadable", ciphertext: secret.ciphertext };
    }
  });
}

/** Load credential auth outside transactions; retain the ref for a transactional recheck. */
export async function prepareStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
  reads?: CatalogReads,
): Promise<{ ref: string | null; auth: StoredModelAuthRead }> {
  const secret = await loadStoredModelSecret(prisma, secretStore, userId, secretId, reads);
  if (secret.status === "missing") return { ref: null, auth: { status: "unreadable" } };
  if (secret.status === "unreadable") {
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  const { plaintext } = secret;
  let message: string | undefined;
  try {
    message = validateModelAuthAvailability(provider, modelId, plaintext);
  } catch {
    // A secret that decrypts but does not parse is as unreadable as a corrupt one.
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  // validateModelAuthAvailability already parsed the secret without throwing.
  if (
    message &&
    (await codexLiveListsModel(live, userId, parseModelSecret(plaintext), modelId, liveOpts))
  ) {
    return { ref: secret.ciphertext, auth: { status: "ready" } };
  }
  return {
    ref: secret.ciphertext,
    auth: message ? { status: "rejected", message } : { status: "ready" },
  };
}

export async function readStoredModelAuth(
  ...args: Parameters<typeof prepareStoredModelAuth>
): Promise<StoredModelAuthRead> {
  return (await prepareStoredModelAuth(...args)).auth;
}

/** Readable rejection when a stored credential cannot call this catalog model. */
export async function validateStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
  reads?: CatalogReads,
): Promise<string | undefined> {
  const auth = await readStoredModelAuth(
    prisma,
    secretStore,
    userId,
    secretId,
    provider,
    modelId,
    live,
    liveOpts,
    reads,
  );
  // Unreadable credentials fail when the run loads them, not as an auth mismatch.
  return auth.status === "rejected" ? auth.message : undefined;
}

/**
 * The ids an openai-compatible connection serves in this space, default first. The
 * secret is account-wide but the default is per space, so the default is unioned in.
 */
export function enabledOpenAiCompatibleModelIds(
  secret: StoredModelSecret | undefined,
  defaultModel: string | null | undefined,
): string[] {
  const listed = secret?.kind === "openai_compatible" ? (secret.enabledModelIds ?? []) : [];
  const ids = [defaultModel, ...listed].map((id) => usableModelId(id));
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

async function loadModelSecret(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  reads?: CatalogReads,
): Promise<StoredModelSecret | undefined> {
  const secret = await loadStoredModelSecret(prisma, secretStore, userId, secretId, reads);
  if (secret.status !== "loaded") return undefined;
  try {
    return parseModelSecret(secret.plaintext);
  } catch {
    // A secret that decrypts but does not parse is as unreadable as a corrupt one.
    return undefined;
  }
}

export type ConnectedModelResolution = {
  /** The connection a role row is pinned to; nothing else may serve it. */
  credentialId?: string | null;
  hostedProvider?: string;
  codexCatalog?: CodexLiveCatalog;
  /** Preview a connection save using the same runtime selection. */
  replacement?: { credentialId: string; secret: StoredModelSecret; defaultModel?: string | null };
};

/** Keep space/model ownership first, then use another connection that explicitly enables the id. */
export async function findConnectedModelCredential(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId?: string | null,
  resolution: ConnectedModelResolution = {},
): Promise<ModelCredential> {
  if (resolution.credentialId)
    return findModelCredentialById(prisma, actor, resolution.credentialId, provider);
  let selected = await findModelCredential(prisma, actor, provider, modelId);
  const replacement = resolution.replacement;
  if (
    selected &&
    selected.id === replacement?.credentialId &&
    replacement.defaultModel !== undefined
  ) {
    selected = { ...selected, defaultModel: replacement.defaultModel };
  }
  const readSecret = (credential: { id: string; secretId: string }) =>
    credential.id === replacement?.credentialId
      ? Promise.resolve(replacement.secret)
      : loadModelSecret(prisma, secretStore, actor.userId, credential.secretId);
  const id = usableModelId(modelId);
  if (!selected || provider !== OPENAI_COMPATIBLE_PROVIDER_ID || !id) return selected;
  if (selected.defaultModel === id) return selected;
  const secret = await readSecret(selected);
  const preferred = {
    credential: selected,
    enabledModelIds: secret?.kind === "openai_compatible" ? secret.enabledModelIds : [],
    defaultModel: selected.defaultModel,
  };
  if (preferred.enabledModelIds?.includes(id)) return selected;
  const credentials = await prisma.userModelCredential.findMany({
    where: { userId: actor.userId, provider },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  const candidates = [];
  for (const credential of credentials) {
    if (credential.id === selected.id) continue;
    const candidate = await readSecret(credential);
    candidates.push({
      credential: { ...credential, defaultModel: null, thinkingLevel: null },
      defaultModel: null,
      enabledModelIds: candidate?.kind === "openai_compatible" ? candidate.enabledModelIds : [],
    });
  }
  return selectCompatibleModelCredential(preferred, candidates, id)?.credential ?? selected;
}

export type BotModelChangeDeps = {
  hostedProvider?: string;
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  codexCatalog?: CodexLiveCatalog;
  refreshExpiredCredential: (
    scope: { userId: string; spaceId: string },
    secretId: string,
    provider: string,
  ) => void;
  /** The space's default model, used for the thinking-level check when the bot has none. */
  defaultModel: () => Promise<{ provider: string | null; model: string | null }>;
};

export type BotModelChangeResult =
  | { ok: true; provider: string | null; model: string | null; thinkingLevel: string | null }
  | { ok: false; error: string };

/**
 * The rules for changing a bot's model and thinking level. `provider` and `model`
 * are the values the bot will have; `current` is what it has now. Settings resend
 * the saved model on every save, so the model checks run only when it changes.
 */
export async function validateBotModelChange(
  deps: BotModelChangeDeps,
  input: {
    userId: string;
    spaceId: string;
    provider: string | null;
    model: string | null;
    thinkingLevel?: string | null;
    current?: { provider: string | null; model: string | null };
  },
): Promise<BotModelChangeResult> {
  const scope = { userId: input.userId, spaceId: input.spaceId };
  const { provider, model } = input;
  const changing = provider !== input.current?.provider || model !== input.current?.model;
  if (changing && provider && model) {
    const hosted =
      deps.hostedProvider === provider &&
      (await hasHostedModelCredits(deps.prisma, scope, provider));
    const credential = hosted
      ? null
      : await findConnectedModelCredential(deps.prisma, deps.secretStore, scope, provider, model);
    if (!credential) {
      if (hosted && isCatalogModelChoice(provider, model)) {
        if (!creditsCanPriceModel({ provider, id: model }))
          return { ok: false, error: MODEL_UNPRICED_FOR_CREDITS_ERROR };
        const allowed = listPiCatalog().find(
          (entry) => entry.provider === provider && entry.id === model,
        )?.thinkingLevels;
        if (
          input.thinkingLevel &&
          allowed &&
          !allowed.some((level) => level === input.thinkingLevel)
        )
          return { ok: false, error: "Unsupported thinking level" };
        return { ok: true, provider, model, thinkingLevel: input.thinkingLevel ?? null };
      }
      return { ok: false, error: PINNED_PROVIDER_NOT_CONNECTED };
    }
    const inCatalog =
      isCatalogModelChoice(provider, model) ||
      (await credentialLiveListsModel(
        deps.prisma,
        deps.secretStore,
        input.userId,
        credential.secretId,
        provider,
        model,
        deps.codexCatalog,
      ));
    if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      const error = await validateConnectedModelChoice(
        deps.prisma,
        deps.secretStore,
        scope,
        provider,
        model,
      );
      if (error) return { ok: false, error };
    } else if (!inCatalog && credential.defaultModel !== model) {
      return { ok: false, error: "Unknown model for that provider" };
    }
    if (inCatalog) {
      const authError = await validateStoredModelAuth(
        deps.prisma,
        deps.secretStore,
        input.userId,
        credential.secretId,
        provider,
        model,
        deps.codexCatalog,
        {
          onExpiredToken: () => deps.refreshExpiredCredential(scope, credential.secretId, provider),
        },
      );
      if (authError) return { ok: false, error: authError };
    }
  }
  const thinkingLevel = input.thinkingLevel ?? null;
  if (thinkingLevel) {
    const defaults = provider && model ? null : await deps.defaultModel();
    const effectiveProvider = provider ?? defaults?.provider;
    const effectiveModelId = model ?? defaults?.model;
    if (effectiveProvider && effectiveModelId) {
      const { allowed } = await prepareAllowedThinkingLevels(
        deps,
        scope,
        effectiveProvider,
        effectiveModelId,
      );
      if (allowed && !allowed.includes(thinkingLevel)) {
        return { ok: false, error: `Thinking level must be one of: ${allowed.join(", ")}` };
      }
    }
  }
  return { ok: true, provider, model, thinkingLevel };
}

/**
 * Thinking levels a caller may set for a provider/model. Catalog models answer from
 * `thinkingLevels`; unknown catalog ids return undefined (no check). OpenAI-compatible
 * connections advertise the endpoint's levels for every enabled model id.
 */
export async function prepareAllowedThinkingLevels(
  deps: Pick<BotModelChangeDeps, "prisma" | "secretStore">,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
  resolution: ConnectedModelResolution = {},
): Promise<{
  allowed: string[] | undefined;
  secret?: { id: string; ciphertext: string };
  enabledModelIds?: string[];
  storedEnabledModelIds?: string[];
}> {
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return {
      allowed: listPiCatalog().find(
        (item) => item.provider === canonicalPiProviderId(provider) && item.id === modelId,
      )?.thinkingLevels,
    };
  }
  const credential = await findConnectedModelCredential(
    deps.prisma,
    deps.secretStore,
    actor,
    provider,
    modelId,
    resolution,
  );
  if (!credential) return { allowed: ["off"] };
  const secret = await loadStoredModelSecret(
    deps.prisma,
    deps.secretStore,
    actor.userId,
    credential.secretId,
  );
  return {
    ...compatibleThinkingLevels(
      credential,
      secret.status === "loaded" ? secret.plaintext : undefined,
      modelId,
    ),
    secret:
      secret.status === "missing"
        ? undefined
        : { id: credential.secretId, ciphertext: secret.ciphertext },
  };
}

/**
 * Thinking levels for `modelId` on an openai-compatible connection whose secret is
 * `plaintext`: the endpoint's levels for any enabled id, otherwise only "off".
 */
export function compatibleThinkingLevels(
  row: Parameters<typeof modelCredentialDto>[0],
  plaintext: string | undefined,
  modelId: string,
) {
  let parsed: StoredModelSecret | undefined;
  let levels: string[] | undefined;
  if (plaintext !== undefined) {
    try {
      parsed = parseModelSecret(plaintext);
      levels = modelCredentialDto(row, plaintext).thinkingLevels;
    } catch {
      // Unreadable connections must not advertise reasoning support.
    }
  }
  const enabled = enabledOpenAiCompatibleModelIds(parsed, row.defaultModel);
  return {
    allowed:
      parsed?.kind === "openai_compatible" &&
      (parsed.enabledModelIds === undefined || enabled.includes(modelId.trim()))
        ? (levels ?? ["off"])
        : ["off"],
    enabledModelIds: enabled,
    storedEnabledModelIds:
      parsed?.kind === "openai_compatible" ? parsed.enabledModelIds : undefined,
  };
}

export async function validateConnectedModelChoice(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
  resolution: ConnectedModelResolution = {},
) {
  if (
    resolution.hostedProvider === provider &&
    (await hasHostedModelCredits(prisma, actor, provider))
  ) {
    return isCatalogModelChoice(provider, modelId) ? undefined : "Unknown model for that provider";
  }
  const credential = await findConnectedModelCredential(
    prisma,
    secretStore,
    actor,
    provider,
    modelId,
    resolution,
  );
  if (!credential) return PINNED_PROVIDER_NOT_CONNECTED;
  if (!usableModelId(modelId)) return "Unknown model for that provider";
  // Compatible catalog entries are placeholders, not evidence that this
  // connection enables that id. Only legacy connections keep that exception.
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return isCatalogModelChoice(provider, modelId) ||
      (await credentialLiveListsModel(
        prisma,
        secretStore,
        actor.userId,
        credential.secretId,
        provider,
        modelId,
        resolution.codexCatalog,
      ))
      ? undefined
      : "Unknown model for that provider";
  }
  const savedChoice = await prisma.userModelPreference.findFirst({
    where: {
      userId: actor.userId,
      modelId,
      credential: { userId: actor.userId, provider },
      ...(resolution.credentialId ? { credentialId: resolution.credentialId } : {}),
    },
    select: { credentialId: true },
  });
  if (savedChoice) return undefined;
  const secret = await loadModelSecret(prisma, secretStore, actor.userId, credential.secretId);
  if (secret?.kind === "openai_compatible" && secret.enabledModelIds === undefined)
    return undefined;
  const enabled = secret && enabledOpenAiCompatibleModelIds(secret, credential.defaultModel);
  return enabled?.includes(modelId.trim()) ? undefined : "Unknown model for that provider";
}

export type ModelChoice = {
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

/**
 * The model a queued run will use. `modelPinned` is the choice captured when the
 * run was created. Model columns written later only record the attempt, so a
 * routine that follows its bot still follows the bot after a resume.
 */
export function runModelChoice(
  run: ModelChoice & { modelPinned?: boolean },
  bot: ModelChoice,
): ModelChoice {
  if (run.modelPinned && run.modelProvider && usableModelId(run.modelId)) {
    return {
      modelProvider: run.modelProvider,
      modelId: run.modelId,
      thinkingLevel: run.thinkingLevel,
    };
  }
  return {
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    thinkingLevel: bot.thinkingLevel,
  };
}

/** The model columns a routine's run starts with; empty when it follows the bot. */
export function routineRunModelPin(routine: ModelChoice): {
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string | null;
  modelPinned?: true;
} {
  if (!routine.modelProvider || !routine.modelId) return {};
  return {
    modelProvider: routine.modelProvider,
    modelId: routine.modelId,
    thinkingLevel: routine.thinkingLevel,
    modelPinned: true,
  };
}

/**
 * One inbound delivery is one turn. Pin a model only when every routine in that
 * delivery chose the same one; mixed choices stay on the bot's model.
 */
export function inboundRoutineModelPin(routines: readonly ModelChoice[]) {
  const pins = routines.map((routine) => routineRunModelPin(routine));
  const first = pins[0];
  if (!first) return {};
  const agreed = pins.every(
    (pin) =>
      pin.modelPinned === first.modelPinned &&
      pin.modelProvider === first.modelProvider &&
      pin.modelId === first.modelId &&
      (pin.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  return agreed ? first : {};
}

/** Why a pinned model cannot run on the credential that was found for it. */
export function pinnedModelCredentialError(
  choice: ModelChoice,
  credential: { defaultModel: string | null } | null,
): string | undefined {
  if (!choice.modelProvider || !usableModelId(choice.modelId)) return undefined;
  if (!credential) return PINNED_PROVIDER_NOT_CONNECTED;
  // The enabled list lives in the secret, so the run path checks openai-compatible ids.
  if (choice.modelProvider === OPENAI_COMPATIBLE_PROVIDER_ID) return undefined;
  const modelId = usableModelId(choice.modelId);
  if (
    modelId &&
    !isCatalogModelChoice(choice.modelProvider, modelId) &&
    !liveCatalogEntry(choice.modelProvider, modelId) &&
    credential.defaultModel !== modelId
  ) {
    return "Unknown model for that provider";
  }
  return undefined;
}

/**
 * A server key is available only to a funded organization and only for its configured provider.
 * A personal connection takes precedence over hosted credits in every funding mode.
 */
export async function hasHostedModelCredits(
  prisma: PrismaClient,
  scope: { userId: string; spaceId: string },
  provider: string,
): Promise<boolean> {
  const deployment = resolveDeploymentModel();
  if (!deployment.configured || deployment.provider !== provider) return false;
  const space = await prisma.space.findFirst({
    where: {
      id: scope.spaceId,
      organization: { members: { some: { userId: scope.userId, role: { not: GUEST_ROLE } } } },
    },
    select: {
      organization: { select: { modelCredits: { select: { mode: true, balanceMicros: true } } } },
    },
  });
  // A guest in someone's shared Space is paid for by their own organization.
  const guestPayer = space ? null : await organizationForMember(prisma, scope);
  const credits = space
    ? space.organization.modelCredits
    : guestPayer
      ? await prisma.modelCreditAccount.findUnique({
          where: { organizationId: guestPayer.organizationId },
          select: { mode: true, balanceMicros: true },
        })
      : null;
  if (credits?.mode !== "credits" && (!credits || credits.balanceMicros <= 0n)) return false;
  return !(await prisma.userModelCredential.findFirst({
    where: { userId: scope.userId, provider: modelCredentialProviderFilter(provider) },
    select: { id: true },
  }));
}
