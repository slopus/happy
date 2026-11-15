import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { ThinkingLevel } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { StoredModelSecret } from "./model-secret.js";
import { parseModelSecret } from "./model-secret.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import { LiveCatalogCache, liveModelCatalogEnabled } from "./pi-live-cache.js";
import type { CatalogSpaceAuth } from "./pi-live-catalog.js";
import { liveCatalogEntry, overlayLiveCatalog } from "./pi-live-catalog.js";
import type { PiCatalogEntry } from "./pi-models.js";
import { listPiCatalog } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER, oauthCredentialAccountId } from "./pi-oauth.js";

/**
 * The ChatGPT backend reports which Codex models a subscription account can call.
 * `client_version` is pinned so reads stay deterministic; bump it to ask the
 * backend for a newer compatibility view.
 */
export const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_VERSION = "0.159.3";

const CODEX_CATALOG_TIMEOUT_MS = 12_000;
const CODEX_CATALOG_HARD_DEADLINE_MS = CODEX_CATALOG_TIMEOUT_MS + 10_000;
const CODEX_CATALOG_MAX_BYTES = 1024 * 1024;
const MAX_CODEX_MODELS = 128;
const MAX_CODEX_LIST_ITEMS = 32;
const MAX_REASONING_LEVELS = 16;
const MAX_CATALOG_CACHE_ENTRIES = 256;
const CATALOG_TTL_MS = 15 * 60_000;
const CATALOG_FAILURE_TTL_MS = 60_000;
const CATALOG_READ_WAIT_MS = 1_500;
/**
 * How long a last-good catalog may keep answering after its TTL while refreshes
 * keep failing; beyond it reads fall back to the static catalog so a removed
 * model does not stay selectable forever.
 */
const CATALOG_STALE_MAX_AGE_MS = 4 * 60 * 60_000;

export type CodexCatalogModel = {
  slug: string;
  reasoningEfforts: string[];
  contextWindow?: number;
  /** Absent when the account list omits `input_modalities`. */
  supportsImages?: boolean;
  supportsFastTier: boolean;
};

export type CodexCatalogFailureReason = "transport" | "timeout" | "http" | "malformed";

export type CodexCatalogResult =
  | { status: "ok"; models: CodexCatalogModel[] }
  | { status: "error"; reason: CodexCatalogFailureReason; httpStatus?: number };

/**
 * `accessToken` returns the held bearer, or null once it expires: the catalog
 * path never refreshes or writes credentials; the runtime's locked refresh owns
 * all token writes.
 */
export type CodexCatalogAccount = {
  accountId: string;
  accessToken: () => Promise<string | null>;
};

export interface CodexLiveCatalog {
  read(
    userId: string,
    account: CodexCatalogAccount,
    opts?: { waitMs?: number },
  ): Promise<CodexCatalogModel[] | undefined>;
}

/**
 * Options for a live catalog check. `waitMs` bounds how long a cold read waits
 * for an in-flight fetch (`0` consults only settled cache state while still
 * kicking a background revalidation on a miss — safe inside a transaction).
 * `onExpiredToken` fires when the stored bearer is expired so the caller can
 * kick a detached refresh through the runtime's credential lock.
 */
export type CodexLiveReadOptions = {
  waitMs?: number;
  onExpiredToken?: () => void;
};

/** GET the backend's per-account model list. Failure modes are typed, never thrown. */
export async function fetchCodexCatalog(
  accessToken: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexCatalogResult> {
  const url = `${CODEX_MODELS_ENDPOINT}?client_version=${CODEX_CLIENT_VERSION}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "rakazo",
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(CODEX_CATALOG_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { status: "error", reason: name === "TimeoutError" ? "timeout" : "transport" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "error", reason: "http", httpStatus: response.status };
  }
  const text = await readBoundedText(response);
  if (text === undefined) return { status: "error", reason: "malformed" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { status: "error", reason: "malformed" };
  }
  const models = parseCodexCatalog(payload);
  return models ? { status: "ok", models } : { status: "error", reason: "malformed" };
}

async function readBoundedText(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > CODEX_CATALOG_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CODEX_CATALOG_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return undefined;
  }
}

const INVALID = Symbol("invalid-codex-catalog");

/**
 * Parse the backend response: keep only `visibility === "list" && supported_in_api`.
 * Any malformed entry fails the whole catalog so a broken response cannot wipe the list.
 */
export function parseCodexCatalog(payload: unknown): CodexCatalogModel[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length > MAX_CODEX_MODELS) return undefined;
  const catalog: CodexCatalogModel[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object") return undefined;
    const entry = item as Record<string, unknown>;
    if (typeof entry.visibility !== "string" || typeof entry.supported_in_api !== "boolean") {
      return undefined;
    }
    if (entry.visibility !== "list" || !entry.supported_in_api) continue;
    if (typeof entry.slug !== "string" || !isValidSlug(entry.slug)) return undefined;
    const reasoningEfforts = parseReasoningEfforts(entry.supported_reasoning_levels);
    const contextWindow = parseContextWindow(entry.context_window);
    const supportsImages = parseSupportsImages(entry.input_modalities);
    const supportsFastTier = stringListContains(entry.additional_speed_tiers, "fast");
    if (
      reasoningEfforts === INVALID ||
      contextWindow === INVALID ||
      supportsImages === INVALID ||
      supportsFastTier === INVALID
    ) {
      return undefined;
    }
    catalog.push({
      slug: entry.slug,
      reasoningEfforts,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(supportsImages !== undefined ? { supportsImages } : {}),
      supportsFastTier,
    });
  }
  return catalog;
}

/** Printable non-space ASCII only, bounded length. */
function isValidSlug(slug: string): boolean {
  return /^[\x21-\x7e]{1,1024}$/.test(slug);
}

function parseReasoningEfforts(value: unknown): string[] | typeof INVALID {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REASONING_LEVELS) return INVALID;
  const efforts: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return INVALID;
    const effort = (entry as Record<string, unknown>).effort;
    if (typeof effort !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(effort)) return INVALID;
    efforts.push(effort);
  }
  return efforts;
}

function parseContextWindow(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    return INVALID;
  }
  return value;
}

/** Omitted or null modalities are unknown. A present list is an explicit yes or no. */
function parseSupportsImages(value: unknown): boolean | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  return stringListContains(value, "image");
}

function stringListContains(value: unknown, expected: string): boolean | typeof INVALID {
  if (value === undefined || value === null) return false;
  if (!Array.isArray(value) || value.length > MAX_CODEX_LIST_ITEMS) return INVALID;
  let found = false;
  for (const entry of value) {
    if (typeof entry !== "string") return INVALID;
    if (entry === expected) found = true;
  }
  return found;
}

/** Per-account Codex policy over the shared bounded SWR cache. */
export class CodexCatalogCache implements CodexLiveCatalog {
  private readonly cache: LiveCatalogCache<CodexCatalogModel>;
  private readonly fetchImpl: typeof fetch;
  private readonly enabledOverride: boolean | undefined;
  constructor(
    opts: {
      enabled?: boolean;
      fetch?: typeof fetch;
      now?: () => number;
      ttlMs?: number;
      failureTtlMs?: number;
      waitMs?: number;
      deadlineMs?: number;
      staleMaxAgeMs?: number;
    } = {},
  ) {
    this.enabledOverride = opts.enabled;
    this.fetchImpl = opts.fetch ?? fetch;
    this.cache = new LiveCatalogCache({
      now: opts.now,
      ttlMs: opts.ttlMs ?? CATALOG_TTL_MS,
      failureTtlMs: opts.failureTtlMs ?? CATALOG_FAILURE_TTL_MS,
      waitMs: opts.waitMs ?? CATALOG_READ_WAIT_MS,
      deadlineMs: opts.deadlineMs ?? CODEX_CATALOG_HARD_DEADLINE_MS,
      staleMaxAgeMs: opts.staleMaxAgeMs ?? CATALOG_STALE_MAX_AGE_MS,
      maxEntries: MAX_CATALOG_CACHE_ENTRIES,
    });
  }
  read(
    userId: string,
    account: CodexCatalogAccount,
    opts?: { waitMs?: number },
  ): Promise<CodexCatalogModel[] | undefined> {
    if (!(this.enabledOverride ?? liveModelCatalogEnabled())) return Promise.resolve(undefined);
    return this.cache.read(
      `${userId}:${account.accountId}`,
      async () => {
        let accessToken: string | null;
        try {
          accessToken = await account.accessToken();
        } catch {
          return { attempted: false };
        }
        if (!accessToken) return { attempted: false };
        const result = await fetchCodexCatalog(accessToken, account.accountId, this.fetchImpl);
        return { attempted: true, models: result.status === "ok" ? result.models : undefined };
      },
      opts?.waitMs,
    );
  }
}

export type CodexCatalogSpaceAuth = CatalogSpaceAuth;

/** Null without an account id. */
function codexAccountHandle(
  credential: OAuthCredential,
  onExpiredToken?: () => void,
): CodexCatalogAccount | null {
  const accountId = oauthCredentialAccountId(credential);
  if (!accountId) return null;
  return {
    accountId,
    accessToken: async () => {
      if (credential.expires > Date.now()) return credential.access;
      onExpiredToken?.();
      return null;
    },
  };
}

/**
 * The account's own row for this slug, when the catalog can be read.
 * Missing, unreadable, and failed catalogs return undefined so callers keep
 * the static answer instead of inventing one.
 */
export async function codexLiveModel(
  catalog: CodexLiveCatalog | undefined,
  userId: string,
  secret: StoredModelSecret,
  modelId: string,
  opts?: CodexLiveReadOptions,
): Promise<CodexCatalogModel | undefined> {
  if (!catalog || secret.kind !== "oauth" || secret.reconnectRequired) return undefined;
  const account = codexAccountHandle(secret.credential, opts?.onExpiredToken);
  if (!account) return undefined;
  const models = await catalog.read(userId, account, opts).catch(() => undefined);
  return models?.find((model) => model.slug === modelId);
}

/** Consulted only when the static auth gate already rejected a catalog model. */
export async function codexLiveListsModel(
  catalog: CodexLiveCatalog | undefined,
  userId: string,
  secret: StoredModelSecret,
  modelId: string,
  opts?: CodexLiveReadOptions,
): Promise<boolean> {
  return Boolean(await codexLiveModel(catalog, userId, secret, modelId, opts));
}

function knownCodexSlugs(): Set<string> {
  return new Set(
    listPiCatalog()
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id),
  );
}

/**
 * Select a usable default for a newly connected ChatGPT account. A requested
 * model stays selected when that account lists it; otherwise use the account's
 * recommended (or first) model. Failed and untrusted catalog reads retain the
 * requested value so the normal static fallback remains intact.
 */
export async function resolveCodexOAuthDefaultModel(
  catalog: CodexLiveCatalog | undefined,
  userId: string,
  secret: StoredModelSecret,
  requestedModelId: string | null | undefined,
  opts?: CodexLiveReadOptions,
): Promise<string | undefined> {
  const requested = requestedModelId?.trim() || undefined;
  if (!catalog || secret.kind !== "oauth" || secret.reconnectRequired) return requested;
  const account = codexAccountHandle(secret.credential, opts?.onExpiredToken);
  if (!account) return requested;
  const models = await catalog.read(userId, account, opts).catch(() => undefined);
  if (!models?.length || !models.some((model) => knownCodexSlugs().has(model.slug)))
    return requested;

  const secretId = "new-oauth-connection";
  const auth: CodexCatalogSpaceAuth = {
    byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
    byModel: {},
    secretIdByProvider: { [CHATGPT_OAUTH_PROVIDER]: secretId },
  };
  const base = listAvailablePiCatalog(auth.byProvider, auth.byModel).filter(
    (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER,
  );
  const available = applyCodexLiveCatalog(base, auth, new Map([[secretId, models]])).filter(
    (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER,
  );
  if (requested && available.some((entry) => entry.id === requested)) return requested;
  return available.find((entry) => entry.recommended)?.id ?? available[0]?.id ?? requested;
}

/**
 * Keyed by credential secret id. Unreadable, non-OAuth, or account-less
 * credentials, and failed reads, map to no entry so their models keep the
 * static availability (which hides Codex Spark).
 */
export async function codexLiveCatalogsForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: { userId: string; spaceId: string },
  auth: CodexCatalogSpaceAuth,
  catalog: CodexLiveCatalog,
  opts?: { onExpiredToken?: (secretId: string) => void },
): Promise<Map<string, CodexCatalogModel[]>> {
  const live = new Map<string, CodexCatalogModel[]>();
  const secretIds = oauthCodexSecretIds(auth);
  if (secretIds.length === 0) return live;
  const secrets = await prisma.secret.findMany({
    where: { id: { in: secretIds }, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  const accounts = new Map<string, CodexCatalogAccount>();
  for (const secret of secrets) {
    let credential: OAuthCredential | undefined;
    try {
      const parsed = parseModelSecret(await secretStore.load(secret.ciphertext, secret.id));
      credential =
        parsed.kind === "oauth" && !parsed.reconnectRequired ? parsed.credential : undefined;
    } catch {
      // Unreadable secrets keep static behavior.
    }
    const account = credential
      ? codexAccountHandle(credential, () => opts?.onExpiredToken?.(secret.id))
      : null;
    if (account) accounts.set(secret.id, account);
  }
  await Promise.all(
    [...accounts].map(async ([secretId, account]) => {
      const models = await catalog.read(scope.userId, account).catch(() => undefined);
      if (models) live.set(secretId, models);
    }),
  );
  return live;
}

function oauthCodexSecretIds(auth: CodexCatalogSpaceAuth): string[] {
  const ids = new Set<string>();
  if (auth.byProvider[CHATGPT_OAUTH_PROVIDER] === "oauth") {
    const id = auth.secretIdByProvider?.[CHATGPT_OAUTH_PROVIDER];
    if (id) ids.add(id);
  }
  const byModel = auth.byModel[CHATGPT_OAUTH_PROVIDER] ?? {};
  for (const modelId of Object.keys(byModel)) {
    if (byModel[modelId] !== "oauth") continue;
    const id = auth.secretIdByModel?.[CHATGPT_OAUTH_PROVIDER]?.[modelId];
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * A codex entry governed by a ChatGPT OAuth credential is available exactly when
 * that credential's own catalog lists it, which can restore statically excluded
 * models like Codex Spark. Other entries keep their static behavior. A catalog
 * sharing no known static slug is ignored as untrusted.
 */
export function applyCodexLiveCatalog(
  base: readonly PiCatalogEntry[],
  auth: CodexCatalogSpaceAuth,
  liveBySecretId: ReadonlyMap<string, readonly CodexCatalogModel[]>,
): PiCatalogEntry[] {
  const knownSlugs = knownCodexSlugs();
  const trusted = new Map<string, Map<string, CodexCatalogModel>>();
  for (const [secretId, models] of liveBySecretId) {
    if (!models.some((model) => knownSlugs.has(model.slug))) continue;
    trusted.set(secretId, new Map(models.map((model) => [model.slug, model])));
  }
  if (trusted.size === 0) return [...base];
  const resolve = (entry: PiCatalogEntry) => {
    if (entry.provider !== CHATGPT_OAUTH_PROVIDER) return undefined;
    const modelKind = auth.byModel[entry.provider]?.[entry.id];
    const kind = modelKind ?? auth.byProvider[entry.provider] ?? "disconnected";
    const secretId =
      modelKind === undefined
        ? auth.secretIdByProvider?.[entry.provider]
        : auth.secretIdByModel?.[entry.provider]?.[entry.id];
    const live = kind === "oauth" && secretId ? trusted.get(secretId) : undefined;
    return live;
  };
  const retained = base.filter((entry) => {
    const live = resolve(entry);
    return !live || live.has(entry.id);
  });
  const additions: PiCatalogEntry[] = [];
  const candidateIds = new Set(
    oauthCodexSecretIds(auth).flatMap((secretId) => [...(trusted.get(secretId)?.keys() ?? [])]),
  );
  for (const id of candidateIds) {
    if (knownSlugs.has(id)) continue;
    const entry = liveCatalogEntry(CHATGPT_OAUTH_PROVIDER, id);
    const model = entry && resolve(entry)?.get(id);
    if (entry && model) additions.push(withLiveFields(entry, model));
  }
  return overlayLiveCatalog(
    retained,
    listPiCatalog(),
    (entry) => {
      const model = resolve(entry)?.get(entry.id);
      return model ? withLiveFields(entry, model) : undefined;
    },
    additions,
  );
}

function withLiveFields(entry: PiCatalogEntry, model: CodexCatalogModel): PiCatalogEntry {
  const thinkingLevels = liveThinkingLevels(model);
  // An explicit account answer decides image input. An omitted list keeps the entry's own.
  const withImages =
    model.supportsImages === undefined ? entry : { ...entry, images: model.supportsImages };
  return thinkingLevels
    ? { ...withImages, reasoning: true, thinkingLevels }
    : { ...withImages, reasoning: entry.reasoning || model.reasoningEfforts.length > 0 };
}

function liveThinkingLevels(model: CodexCatalogModel): ThinkingLevel[] | undefined {
  const levels = [
    ...new Set(
      model.reasoningEfforts.flatMap((effort) => {
        const parsed = ThinkingLevelSchema.safeParse(effort);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
  return levels.length > 0 ? levels : undefined;
}
