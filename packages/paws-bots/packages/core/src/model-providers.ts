import type { Bot, ModelApiProtocol, ModelCatalogEntry } from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  DEFAULT_MODEL_MAX_TOKENS,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  selectCompatibleModelCredential,
  withConnectionName,
} from "@rakazo/contracts";
import { listSearch } from "./list-search.js";

/** Bots that pick their own model ignore the space default and its changes. */
export function botsWithOwnModel<T extends Pick<Bot, "modelProvider" | "modelId">>(
  bots: readonly T[],
): T[] {
  return bots.filter((bot) => Boolean(bot.modelProvider && bot.modelId));
}

/** Effort choices an OpenAI-compatible endpoint stores when reasoning is enabled. */
export const COMPATIBLE_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Effort choices by wire protocol. Anthropic Messages maps every level to a
 * budget, and pi-ai's budgets top out at the "high" level, so the two levels
 * above it are not offered for that protocol.
 */
export function compatibleThinkingLevels(
  apiProtocol: ModelApiProtocol | undefined,
): readonly (typeof COMPATIBLE_THINKING_LEVELS)[number][] {
  return apiProtocol === "anthropic-messages"
    ? COMPATIBLE_THINKING_LEVELS.filter((level) => level !== "xhigh" && level !== "max")
    : COMPATIBLE_THINKING_LEVELS;
}

const THINKING_LEVELS = ["off", ...COMPATIBLE_THINKING_LEVELS] as const;

/**
 * The max-tokens field for a connection. An OpenAI-compatible endpoint always sends a limit, so
 * an unsaved one shows the default it would get; catalog providers leave it blank to use theirs.
 */
export function connectionMaxTokensField(providerId: string, stored: number | undefined): string {
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return String(stored ?? DEFAULT_MODEL_MAX_TOKENS);
  }
  return stored !== undefined ? String(stored) : "";
}

/**
 * Map a staged effort onto the levels a model actually supports.
 * An exact match is kept. Otherwise the nearest supported effort is used
 * (higher first, then lower). Models that cannot think, and the "off" level,
 * reset to null so the runtime default applies.
 * `supported === undefined` means the model is outside the catalog: a concrete
 * level is kept because there is no allowance list to clamp against.
 */
export function clampCatalogThinkingLevel(
  level: string | null | undefined,
  supported: readonly string[] | undefined,
): string | null {
  if (!level || level === "off") return null;
  if (supported === undefined) return level;
  const available = supported.filter((entry) => entry !== "off");
  if (available.length === 0) return null;
  if (available.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]);
  if (requestedIndex === -1) return null;
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index++) {
    const candidate = THINKING_LEVELS[index];
    if (candidate && candidate !== "off" && available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const candidate = THINKING_LEVELS[index];
    if (candidate && candidate !== "off" && available.includes(candidate)) return candidate;
  }
  return null;
}

export const POPULAR_MODEL_PROVIDER_IDS = [
  "openai-codex",
  "anthropic",
  "openai",
  "openrouter",
  "google",
] as const;

const DEFAULT_PROVIDER_COUNT = POPULAR_MODEL_PROVIDER_IDS.length;
const POPULAR_MODEL_PROVIDER_IDS_LIST: readonly string[] = POPULAR_MODEL_PROVIDER_IDS;

/** Popular providers in curated order, then the rest by name. */
export function popularModelProvidersFirst<T>(
  items: readonly T[],
  providerId: (item: T) => string,
  name: (item: T) => string,
): T[] {
  const rank = (item: T) => {
    const index = POPULAR_MODEL_PROVIDER_IDS_LIST.indexOf(providerId(item));
    return index === -1 ? DEFAULT_PROVIDER_COUNT : index;
  };
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) || name(a).localeCompare(name(b), undefined, { sensitivity: "base" }),
  );
}

/**
 * Model to preselect when a provider row is opened: the saved/preferred id
 * when that provider carries it, otherwise its recommended model, then its
 * first catalog entry.
 *
 * Aggregator providers prefix ids with the upstream vendor ("openai/gpt-6-luna"
 * on OpenRouter) while first-party providers expose the same model unprefixed
 * ("gpt-6-luna" on OpenAI Codex), so the preferred id's basename is tried after
 * the exact id. This is only a preselection — the user still confirms the pick.
 */
export function pickCatalogModelId(
  catalog: readonly { provider: string; id: string; recommended?: boolean }[],
  provider: string,
  preferredId?: string | null,
): string {
  const entries = catalog.filter(
    (entry) => canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider),
  );
  if (preferredId) {
    if (entries.some((entry) => entry.id === preferredId)) return preferredId;
    const basename = preferredId.split("/").at(-1);
    if (basename && basename !== preferredId) {
      const shared = entries.find((entry) => entry.id === basename);
      if (shared) return shared.id;
    }
  }
  return entries.find((entry) => entry.recommended)?.id ?? entries[0]?.id ?? "";
}

/**
 * Display forms the DeepSeek API rejects. The selectable id stays the API model
 * id (`deepseek-flash`, `deepseek-v4-pro`); the catalog label can stay human-readable.
 */
const DEEPSEEK_DISPLAY_MODEL_IDS: Record<string, string> = {
  deepseekv41flash: "deepseek-flash",
  deepseekv4pro: "deepseek-v4-pro",
};

export type ConnectedModelChoice = {
  key: string;
  provider: string;
  modelId: string;
  label: string;
  providerLabel?: string;
  modelLabel?: string;
  /** The catalog says whether the model reads images; unknown for free-form ids. */
  images?: boolean;
};

type CatalogModelRef = {
  managed?: boolean;
  provider: string;
  id: string;
  label: string;
  providerName?: string;
  placeholder?: boolean;
  images?: boolean;
};

type CredentialModelRef = {
  provider: string;
  label: string;
  modelId?: string | null;
  enabledModelIds?: readonly string[] | null;
  isDefault?: boolean;
  preferenceRank?: number;
};

function modelToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** API id for a known DeepSeek display label, when it differs from `modelId`. */
function canonicalApiModelId(provider: string, modelId: string): string | undefined {
  if (provider !== "deepseek") return undefined;
  const canonical = DEEPSEEK_DISPLAY_MODEL_IDS[modelToken(modelId)];
  if (!canonical || canonical === modelId) return undefined;
  return canonical;
}

export function modelOptionKey(provider: string, modelId: string): string {
  return `${canonicalPiProviderId(provider)}::${modelId}`;
}

export function parseModelOptionKey(key: string): { provider: string; modelId: string } | null {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return {
    provider: canonicalPiProviderId(key.slice(0, separator)),
    modelId: key.slice(separator + 2),
  };
}

/**
 * Model id safe to submit. Catalog ids pass through. A display label such as
 * "DeepSeek-V4.1-Flash" resolves to the API id the catalog actually calls.
 * An id the catalog does not know stays unchanged so a custom model still works.
 */
export function resolveSelectableModelId(
  catalog: readonly CatalogModelRef[],
  provider: string,
  modelId: string,
): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const canonical = canonicalApiModelId(provider, trimmed);
  if (canonical) return canonical;
  const entries = catalog.filter(
    (entry) =>
      canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider) &&
      !entry.placeholder,
  );
  if (entries.some((entry) => entry.id === trimmed)) return trimmed;
  const token = modelToken(trimmed);
  const byId = entries.filter((entry) => modelToken(entry.id) === token);
  if (byId.length === 1 && byId[0]) return byId[0].id;
  const byLabel = entries.filter(
    (entry) => modelToken(entry.label) === token && modelToken(entry.id) !== token,
  );
  if (byLabel.length === 1 && byLabel[0]) return byLabel[0].id;
  return trimmed;
}

function freeFormChoice(credential: CredentialModelRef, modelId: string): ConnectedModelChoice {
  return {
    key: modelOptionKey(credential.provider, modelId),
    provider: credential.provider,
    modelId,
    label: withConnectionName(modelId, credential.label),
    providerLabel: credential.label,
    modelLabel: modelId,
  };
}

function catalogChoices(providerModels: readonly CatalogModelRef[]): ConnectedModelChoice[] {
  return providerModels.map((entry) => {
    const modelId = resolveSelectableModelId(providerModels, entry.provider, entry.id);
    return {
      key: modelOptionKey(entry.provider, modelId),
      provider: entry.provider,
      modelId,
      label: withConnectionName(entry.label, entry.providerName ?? entry.provider),
      providerLabel: entry.providerName ?? entry.provider,
      modelLabel: entry.label,
      images: entry.images,
    };
  });
}

/** The connected credential that runs `modelId`: an enabled id or the connection default. */
export function credentialForModel<C extends CredentialModelRef>(
  credentials: readonly C[],
  provider: string | null | undefined,
  modelId: string | null | undefined,
): C | undefined {
  if (!provider || !modelId) return undefined;
  const candidates = credentials.filter((credential) => credential.provider === provider);
  const preferences = [...candidates].sort(
    (left, right) =>
      Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)) ||
      (left.preferenceRank ?? Infinity) - (right.preferenceRank ?? Infinity),
  );
  const matching = preferences.filter((credential) => credential.modelId === modelId);
  const preferred =
    preferences.find(
      (credential) =>
        credential.isDefault || credential.preferenceRank !== undefined || credential.modelId,
    ) ?? candidates[0];
  const selected = matching.find((credential) => credential.isDefault) ?? matching[0] ?? preferred;
  if (provider !== "openai-compatible")
    return (
      matching[0] ?? candidates.find((credential) => credential.enabledModelIds?.includes(modelId))
    );
  if (!selected) return undefined;
  const refs = candidates.map((credential) => ({
    credential,
    defaultModel: credential.modelId,
    enabledModelIds: credential.enabledModelIds,
  }));
  return selectCompatibleModelCredential(
    refs.find((ref) => ref.credential === selected)!,
    refs,
    modelId,
  )?.credential;
}

/**
 * Models a connected provider can run. Catalog entries submit their API ids.
 * A saved display label expands to those ids instead of becoming the only choice.
 * A custom id that is not a catalog label stays a single free-form option.
 * A connection with enabled ids offers one free-form option per id.
 */
export function connectedModelChoices(
  credentials: readonly CredentialModelRef[],
  catalog: readonly CatalogModelRef[],
): ConnectedModelChoice[] {
  const choices: ConnectedModelChoice[] = [];
  const seen = new Set<string>();
  for (const credential of credentials) {
    const providerModels = catalog.filter(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(credential.provider) &&
        !entry.placeholder,
    );
    const raw = credential.modelId?.trim() ?? "";
    const resolved = raw ? resolveSelectableModelId(providerModels, credential.provider, raw) : "";
    const resolvedInCatalog = providerModels.some(
      (entry) => resolveSelectableModelId(providerModels, entry.provider, entry.id) === resolved,
    );
    const enabled = (credential.enabledModelIds ?? []).map((id) => id.trim()).filter(Boolean);
    const next: ConnectedModelChoice[] =
      enabled.length > 0
        ? enabled.map((id) => ({
            ...freeFormChoice(credential, id),
            images: providerModels.find((entry) => entry.id === id)?.images,
          }))
        : raw && !resolvedInCatalog
          ? [freeFormChoice(credential, resolved || raw)]
          : catalogChoices(providerModels);
    choices.push(...next);
  }
  choices.push(...catalogChoices(catalog.filter((entry) => entry.managed && !entry.placeholder)));
  return choices.filter((choice) => {
    if (seen.has(choice.key)) return false;
    seen.add(choice.key);
    return true;
  });
}

export type ChatModelChoice = {
  key: string;
  label: string;
  provider?: string;
  modelId?: string;
  providerLabel?: string;
  modelLabel?: string;
  title?: string;
  detail?: string;
  images?: boolean;
};

/** Filter on full labels before shortening rows; saved/default choices stay first. */
export function groupModelChoices(choices: readonly ChatModelChoice[], query: string) {
  const sections: { key: string; heading?: string; data: ChatModelChoice[] }[] = [];
  for (const choice of filterModelChoices(choices, query)) {
    // The catalog has no vendor field. Its display convention is "Vendor: Model".
    const vendor = choice.modelLabel?.match(/^([^:]+): (.+)$/);
    const heading = choice.providerLabel
      ? vendor?.[1]
        ? withConnectionName(vendor[1], choice.providerLabel)
        : choice.providerLabel
      : undefined;
    const key = heading ? `provider:${heading}` : "ungrouped";
    let section = sections.find((entry) => entry.key === key);
    if (!section) {
      section = { key, heading, data: [] };
      if (heading) sections.push(section);
      else sections.unshift(section);
    }
    section.data.push({
      ...choice,
      title: choice.title ?? vendor?.[2] ?? choice.modelLabel ?? choice.label,
    });
  }
  return sections;
}

/**
 * A chat's model picker: the space default (key ""), then a saved model no
 * connection offers any more, then every connected model.
 */
export function chatModelChoices(
  connected: readonly ConnectedModelChoice[],
  selectedKey: string,
  spaceDefaultLabel: string,
  /** Whether the space's default model reads images, when the catalog knows. */
  spaceDefaultImages?: boolean,
): ChatModelChoice[] {
  const choices: ChatModelChoice[] = [
    { key: "", label: spaceDefaultLabel, images: spaceDefaultImages },
  ];
  if (selectedKey && !connected.some((option) => option.key === selectedKey)) {
    const saved = parseModelOptionKey(selectedKey);
    choices.push({
      key: selectedKey,
      label: saved?.modelId ?? selectedKey,
      provider: saved?.provider,
      modelId: saved?.modelId,
    });
  }
  return choices.concat(connected);
}

/**
 * Match a choice by label, model id, provider id, or (for a model that names its provider) the
 * provider's display name; a blank query keeps every choice. A choice without a provider only
 * uses providerLabel as a section heading, so that heading is not searched.
 */
export function filterModelChoices<C extends ChatModelChoice>(
  choices: readonly C[],
  query: string,
): readonly C[] {
  return listSearch(choices, query, { text: modelChoiceSearchText }).visible;
}

type SavedCompatibleModels = { baseUrl?: string; enabledModelIds?: readonly string[] };

/** The server's endpoint form; half-typed text that is not a URL yet compares as trimmed text. */
function comparableBaseUrl(baseUrl: string): string {
  try {
    return normalizeOpenAiCompatibleBaseUrl(baseUrl);
  } catch {
    return baseUrl.trim();
  }
}

/** The saved enabled ids, but only while the form still points at the saved endpoint. */
export function savedCompatibleModelIds(
  credential: SavedCompatibleModels | undefined,
  baseUrl: string,
): string[] {
  if (
    !credential?.enabledModelIds ||
    comparableBaseUrl(credential.baseUrl ?? "") !== comparableBaseUrl(baseUrl)
  ) {
    return [];
  }
  return [...credential.enabledModelIds];
}

/** One row per model the endpoint may run: saved ids, then local ticks, then probed ids. */
export function compatibleModelRows(
  savedIds: readonly string[],
  enabledIds: readonly string[],
  probedIds: readonly string[],
): string[] {
  return [...new Set([...savedIds, ...enabledIds, ...probedIds])];
}

export function toggleEnabledModelId(
  enabledIds: readonly string[],
  id: string,
  enabled: boolean,
): string[] {
  return enabled ? [...new Set([...enabledIds, id])] : enabledIds.filter((entry) => entry !== id);
}

/**
 * Whether "Use this model" may switch the default to `modelId`. The server
 * refuses ids outside a saved list; an unread list (undefined) is not checked.
 */
export function canUseCompatibleModelAsDefault(
  savedIds: readonly string[] | undefined,
  modelId: string,
): boolean {
  return savedIds === undefined || savedIds.includes(modelId);
}

export const modelCatalogSearchText = (entry: ModelCatalogEntry) => [
  entry.label,
  entry.id,
  entry.providerName ?? entry.provider,
];

export const modelChoiceSearchText = (choice: ChatModelChoice) => [
  choice.label,
  choice.modelId,
  choice.provider,
  choice.provider ? choice.providerLabel : undefined,
];
