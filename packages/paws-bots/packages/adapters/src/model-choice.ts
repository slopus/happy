import type { Actor } from "@rakazo/contracts";
import { canonicalPiProviderId } from "@rakazo/contracts";
import type { BotModelChangeDeps } from "./model-selection.js";
import { modelCredentialAuthKindsForSpace, spaceCanRunCatalogModel } from "./model-selection.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { PiCatalogEntry } from "./pi-models.js";
import { listPiCatalog, offeredCatalog } from "./pi-models.js";

export type ModelChoice = Pick<PiCatalogEntry, "provider" | "providerName" | "id" | "label">;

export type ModelChoiceResult =
  | { ok: true; provider: string; model: string }
  | { ok: false; error: string };

const CANDIDATE_LIMIT = 5;
/** Errors echo the query back to the model; a huge one must not inflate the tool result. */
const ECHOED_QUERY_LIMIT = 200;
export const echoedQuery = (query: string) =>
  query.length > ECHOED_QUERY_LIMIT ? `${query.slice(0, ECHOED_QUERY_LIMIT)}…` : query;

/** The catalog models this user's connections, or hosted credits, can run. */
export async function connectedModelChoices(
  deps: Pick<BotModelChangeDeps, "prisma" | "secretStore" | "hostedProvider">,
  scope: Pick<Actor, "userId" | "spaceId">,
): Promise<ModelChoice[]> {
  const auth = await modelCredentialAuthKindsForSpace(
    deps.prisma,
    deps.secretStore,
    scope,
    deps.hostedProvider,
  );
  return offeredCatalog(listAvailablePiCatalog(auth.byProvider, auth.byModel)).filter((entry) => {
    if (entry.placeholder || !spaceCanRunCatalogModel(auth, entry)) return false;
    const kind = auth.byModel[entry.provider]?.[entry.id] ?? auth.byProvider[entry.provider];
    return kind !== undefined && kind !== "disconnected";
  });
}

/**
 * A version an id writes with a hyphen, as in "claude-sonnet-5-5" or "llama3-1-8b": its first
 * number and one more short number, standing on their own. Sizes ("llama-3-8b"), build numbers
 * ("gpt-4-0613") and later dates ("gpt-4o-2024-11-20", "gemini-2.5-pro-preview-11-20") stay apart.
 */
const HYPHENATED_VERSION = /^(\D*)([1-9]?\d)[-_]([1-9]?\d)(?![\p{L}\d.]|[-_]\d{1,2}(?![\p{L}\d]))/u;

/** Words and version numbers: "Gemini 3.8 Flash" and "gemini-3-8-flash" are gemini, 3.8, flash. */
export function words(text: string): string[] {
  return (
    text
      .replace(HYPHENATED_VERSION, "$1$2.$3")
      .toLowerCase()
      .match(/\p{L}+|\d+(?:\.\d+)*/gu) ?? []
  );
}

const isVersion = (word: string) => /^\d/.test(word);

function compareVersions(left: string | undefined, right: string | undefined): number {
  const a = (left ?? "").split(".").map(Number);
  const b = (right ?? "").split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff) return diff;
  }
  return 0;
}

/**
 * Match a model name as people say it ("Claude Sonnet", "gemini flash") or an exact id
 * ("claude-sonnet-5", "openrouter/anthropic/claude-sonnet-5"). Every word said must appear in
 * the model's name; versions only count from its label, so "Sonnet 5" is not Sonnet 4.5. Among
 * matches the bot's current provider wins, then the plainest family (fewest unsaid words, so
 * not "Lite" or "Preview"), then the newest version.
 */
export function matchModelChoice(
  choices: readonly ModelChoice[],
  query: string,
  preferredProvider?: string | null,
): { match?: ModelChoice; ranked: ModelChoice[] } {
  const wanted = query.trim().toLowerCase();
  const exact = choices.filter((choice) =>
    [choice.id, `${choice.provider}/${choice.id}`, `${choice.provider}:${choice.id}`].some(
      (key) => key.toLowerCase() === wanted,
    ),
  );
  const asked = words(query);
  const matches = exact.length
    ? exact
    : asked.length
      ? choices.filter((choice) => {
          const have = new Set([
            ...words(`${choice.provider} ${choice.providerName} ${choice.id}`).filter(
              (word) => !isVersion(word),
            ),
            ...words(choice.label),
          ]);
          return asked.every((word) => have.has(word));
        })
      : [];
  const preferred = preferredProvider ? canonicalPiProviderId(preferredProvider) : undefined;
  const unsaid = (choice: ModelChoice) =>
    words(choice.label).filter((word) => !isVersion(word) && !asked.includes(word)).length;
  const version = (choice: ModelChoice) => words(choice.label).find(isVersion);
  const order = (a: ModelChoice, b: ModelChoice) =>
    Number(b.provider === preferred) - Number(a.provider === preferred) ||
    unsaid(a) - unsaid(b) ||
    compareVersions(version(b), version(a));
  const ranked = [...matches].sort(order);
  const [first, second] = ranked;
  return { match: first && (!second || order(first, second) < 0) ? first : undefined, ranked };
}

const choiceKey = (choice: ModelChoice) => `${choice.provider}/${choice.id}`;

/**
 * Resolve a loose model name against the models this user can run. `provider` limits the search
 * to one provider; `preferredProvider` breaks ties toward it.
 */
export async function resolveModelChoice(
  deps: Pick<BotModelChangeDeps, "prisma" | "secretStore" | "hostedProvider">,
  scope: Pick<Actor, "userId" | "spaceId">,
  input: { model: string; provider?: string; preferredProvider?: string | null },
): Promise<ModelChoiceResult> {
  const provider = input.provider ? canonicalPiProviderId(input.provider) : undefined;
  const connected = (await connectedModelChoices(deps, scope)).filter(
    (choice) => !provider || choice.provider === provider,
  );
  const { match, ranked } = matchModelChoice(
    connected,
    input.model,
    provider ?? input.preferredProvider,
  );
  if (match) return { ok: true, provider: match.provider, model: match.id };
  if (ranked.length)
    return {
      ok: false,
      error: `"${echoedQuery(input.model)}" matches several models. Ask the user which one, or pass its id as model: ${ranked
        .slice(0, CANDIDATE_LIMIT)
        .map((choice) => `${choiceKey(choice)} (${choice.label})`)
        .join(", ")}.`,
    };
  // Live and custom-server ids are not in the bundled catalog; the model check decides those.
  const [prefix = "", ...rest] = input.model.trim().split("/");
  if (provider) return { ok: true, provider, model: input.model.trim() };
  if (rest.length && listPiCatalog().some((entry) => entry.provider === prefix))
    return { ok: true, provider: prefix, model: rest.join("/") };
  const elsewhere = matchModelChoice(
    offeredCatalog(listPiCatalog()).filter(
      (entry) => !entry.placeholder && (!provider || entry.provider === provider),
    ),
    input.model,
  ).ranked;
  const providers = [...new Set(elsewhere.map((choice) => choice.providerName))].slice(0, 3);
  return {
    ok: false,
    error: providers.length
      ? `No connected model matches "${echoedQuery(input.model)}". The user needs to connect ${providers.join(" or ")} in Settings first.`
      : `No model matches "${echoedQuery(input.model)}".`,
  };
}
