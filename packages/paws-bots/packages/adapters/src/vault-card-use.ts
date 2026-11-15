import { BotSecretName, OneTimeCodeTarget } from "@rakazo/contracts";
import type { FleetCardSummary } from "./approval-ask.js";
import type { PurchaseApproval } from "./purchase-gate.js";
import { purchaseCardSummary } from "./purchase-gate.js";

/**
 * A saved card a person approved typing into one checkout: carried in the persisted request, so a
 * replay types exactly that card on exactly that site. `title` is what the approval card showed, and
 * `savedAt` is when the card was last saved, so one replaced while the approval waited is not typed.
 */
export type VaultCardUse = { card: string; site: string; title: string; savedAt: string };
/**
 * A saved login that asks first, approved for one browser_act call: its `fields` on one of its
 * sites, as saved at `savedAt`. The approval card names it by `title`, never a username others
 * could read, and says when the fields include its authenticator code (LOGIN_CODE_FIELD), which
 * no approval without it covers.
 */
export type VaultLoginUse = {
  kind: "login";
  login: string;
  site: string;
  title: string;
  fields: string[];
  savedAt: string;
};

/** A card use as the persisted request holds it, or nothing when it is not one. */
export function vaultCardUseOf(value: unknown): VaultCardUse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { card, site, title, savedAt } = value as Record<string, unknown>;
  if (
    !BotSecretName.safeParse(card).success ||
    !OneTimeCodeTarget.safeParse({ origin: site }).success ||
    typeof title !== "string" ||
    typeof savedAt !== "string"
  )
    return undefined;
  return { card: card as string, site: new URL(site as string).origin, title, savedAt };
}

/** A login use as the persisted request holds it, or nothing when it is not one. */
export function vaultLoginUseOf(value: unknown): VaultLoginUse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, login, site, title, fields, savedAt } = value as Record<string, unknown>;
  if (
    kind !== "login" ||
    !BotSecretName.safeParse(login).success ||
    !OneTimeCodeTarget.safeParse({ origin: site }).success ||
    typeof title !== "string" ||
    !Array.isArray(fields) ||
    !fields.every((field) => typeof field === "string") ||
    typeof savedAt !== "string"
  )
    return undefined;
  return {
    kind,
    login: login as string,
    site: new URL(site as string).origin,
    title,
    fields: fields as string[],
    savedAt,
  };
}

/**
 * What an approval names for a login's authenticator code, which fill_code types. Field labels are
 * trimmed, so none ends in a space and a field named the same is never taken for the code.
 */
export const LOGIN_CODE_FIELD = "Authenticator code ";

/** Each saved login a browser_act call fills, with the fields it fills, as browser_act reads them. */
export function requestedLoginFills(actions: unknown): Map<string, string[]> {
  const fills = new Map<string, string[]>();
  for (const raw of Array.isArray(actions) ? actions : []) {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const login = String(step.secret ?? "").trim();
    const field =
      step.kind === "fill_code"
        ? LOGIN_CODE_FIELD
        : typeof step.field === "string"
          ? step.field.trim()
          : "";
    if ((step.kind !== "fill_secret" && step.kind !== "fill_code") || !login || !field) continue;
    const fields = fills.get(login) ?? [];
    if (!fields.includes(field)) fills.set(login, [...fields, field]);
  }
  return fills;
}

/**
 * The approval card for signing in with a saved login, named from what is saved. It is built from
 * the approval a replay is held to, so allowing it lets the call type nothing the card left out:
 * the one site it names, the login's fields, and its authenticator code only when it says so.
 * It says what the call asks to type: whether the login has a key is in its value, which asking
 * never reads, so a login without one types no code once allowed.
 */
export function loginUseSummary(use: VaultLoginUse): FleetCardSummary {
  const host = new URL(use.site).host;
  return {
    onceOnly: true,
    title: `Sign in to ${host} with ${use.title}?`,
    lines: use.fields.includes(LOGIN_CODE_FIELD)
      ? ["This types the login's authenticator code."]
      : [],
  };
}

/** The site a fill_card step names, reduced to its origin, so a page URL names its site. */
export function cardFillSite(value: unknown): string {
  const text = String(value ?? "").trim();
  return URL.canParse(text) ? new URL(text).origin : text;
}

/**
 * The saved card and checkout a browser_act call types into, from its fill_card steps that name a
 * card. One call types one card on one site, so one approval covers exactly what it shows.
 */
export function requestedCardUse(
  actions: unknown,
): { card: string; site: string } | { error: string } | undefined {
  if (!Array.isArray(actions)) return undefined;
  const uses = actions.flatMap((raw) => {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    // As browser_act reads a step: an empty card beside a purchase is no saved card.
    const card = typeof step.card === "string" ? step.card.trim() : "";
    return step.kind === "fill_card" && card ? [{ card, site: cardFillSite(step.site) }] : [];
  });
  const [first] = uses;
  if (!first) return undefined;
  if (!OneTimeCodeTarget.safeParse({ origin: first.site }).success) {
    return { error: "fill_card with a saved card needs site: the checkout page's HTTPS origin." };
  }
  if (uses.some((use) => use.card !== first.card || use.site !== first.site)) {
    return { error: "Type one saved card on one site per browser_act call." };
  }
  return first;
}

/** The approval card for typing a saved card, with the purchase the same call presses, if any. */
export function cardUseSummary(use: VaultCardUse, purchase?: PurchaseApproval): FleetCardSummary {
  const host = new URL(use.site).host;
  const paying = purchase ? purchaseCardSummary(purchase) : undefined;
  return {
    onceOnly: true,
    title: `Pay with ${use.title} on ${host}?`,
    lines: paying?.lines ?? [],
    ...(paying?.receipt ? { receipt: paying.receipt } : {}),
  };
}
