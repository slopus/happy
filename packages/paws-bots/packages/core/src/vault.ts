import type {
  BotSecretMetadata,
  LoginFieldInput,
  VaultImportProblem,
  VaultKind,
  VaultPolicy,
} from "@rakazo/contracts";
import {
  authenticatorKey,
  BLOCKED_ITEM_ANSWER,
  encodeLoginSecret,
  hasAuthenticatorKey,
  hasVaultAccess,
  LoginSecretValue,
  typedOtherSites,
  UNCHOSEN_ITEM_ANSWER,
} from "@rakazo/contracts";

/**
 * Which fixed refusal a secret answer's server error is. Its other errors could echo the value,
 * so they are never shown.
 */
export function secretAnswerRefusal(error: unknown): "blocked" | "unchosen" | undefined {
  const message = error && typeof error === "object" && "message" in error ? error.message : "";
  return message === BLOCKED_ITEM_ANSWER
    ? "blocked"
    : message === UNCHOSEN_ITEM_ANSWER
      ? "unchosen"
      : undefined;
}

/** Which of the owner's bots may use an item: every one, or those in `botIds`. */
export type VaultBots = { allBots: boolean; botIds: string[] };

/**
 * The Bots controls an item's editor shows, the same on web and mobile: which policies it offers,
 * whether bots are picked, and whether the note under them is said.
 */
export function vaultAccessControls(input: {
  kind: VaultKind;
  policy: VaultPolicy;
  /** Which bots may use it; left out when the server, or this Space, can't limit it to chosen bots. */
  access?: VaultBots;
  /** The bots there are to choose from. */
  bots: readonly { id: string }[];
  /** Said under the bots when only some may use it, or when this Space's can't be chosen. */
  note?: string;
}): { policies: VaultPolicy[]; picker: boolean; note: string | undefined } {
  const { kind, policy, access, bots, note } = input;
  return {
    // Only a login asks first; another kind keeps Ask first only while it is set.
    policies: hasVaultAccess(kind)
      ? (["allow", "ask", "off"] as const).filter(
          (option) => option !== "ask" || kind === "login" || policy === "ask",
        )
      : [],
    // Blocked, no bot may use it at all; a Space without bots has nothing to choose from. A chosen
    // bot the list can't show (archived ones not read yet) would be let go of unseen, or read as
    // none chosen, so nothing is chosen until every one is shown.
    picker:
      Boolean(access) &&
      policy !== "off" &&
      bots.length > 0 &&
      (access?.allBots || access?.botIds.every((id) => bots.some((bot) => bot.id === id)) === true),
    // Said when the choice is limited, or no choice can be made; a blocked item needs neither.
    note: note && policy !== "off" && !access?.allBots ? note : undefined,
  };
}

/**
 * The bots an item's editor offers: the active ones, then each archived one it is limited to,
 * named by `archivedName`, as restoring it brings the choice back and it can be let go of.
 */
export function vaultBotChoices<Bot extends { id: string; name: string; archivedAt?: unknown }>(
  bots: readonly Bot[],
  archived: readonly Bot[],
  chosen: readonly string[],
  archivedName: (name: string) => string,
): Bot[] {
  return [
    ...bots.filter((bot) => !bot.archivedAt),
    ...archived
      .filter((bot) => chosen.includes(bot.id) && !bots.some((active) => active.id === bot.id))
      .map((bot) => ({ ...bot, name: archivedName(bot.name) })),
  ];
}

/** Whether items can be limited to chosen bots: yes unless the saved ones show the server can't. */
export function vaultBotsChoosable(items: readonly { allBots?: boolean }[] | null | undefined) {
  return !items?.length || items.some((item) => item.allBots !== undefined);
}

/**
 * A login's save as both apps' editors send it, or no save while what was typed can't be sent.
 * The key is checked before Save clears what was typed, so a typo is fixed without retyping.
 */
export function vaultLoginSave(input: {
  /** The login's fields as typed; left out when its value isn't being changed. */
  fields?: readonly LoginFieldInput[];
  otp: string;
  savedOtp: string;
  /** The other sites as typed, and as they were shown. */
  alsoOn: string;
  savedAlsoOn: string;
  /** A chat card's answer, which sends neither a key nor other sites. */
  asking: boolean;
}): {
  keyUnreadable: boolean;
  sites: ReturnType<typeof typedOtherSites>;
  save: { value?: string; alsoOn?: string[] } | undefined;
} {
  const { fields, otp, asking } = input;
  const keyUnreadable = !asking && otp.trim() !== "" && !authenticatorKey(otp);
  const sites = asking ? [] : typedOtherSites(input.alsoOn);
  // A key left as shown is not sent, so the saved one stays: the copy shown may be older than it.
  // One that changed is kept inside the login's value, so it waits for the fields to be sent.
  const keyChanged = !asking && otp !== input.savedOtp;
  const login = LoginSecretValue.safeParse({ fields, ...(keyChanged ? { otp } : {}) });
  const save =
    !Array.isArray(sites) || (fields ? !login.success : keyChanged)
      ? undefined
      : {
          ...(fields && login.success ? { value: encodeLoginSecret(login.data) } : {}),
          ...(!asking && input.alsoOn !== input.savedAlsoOn ? { alsoOn: sites } : {}),
        };
  return { keyUnreadable, sites, save };
}

export type VaultSaveDrop = "ask" | "block" | "bots" | "alsoOn" | "authenticatorKey";
export type VaultSaveSent = {
  policy?: VaultPolicy;
  allBots?: boolean;
  alsoOn?: string[];
  value?: string;
};

/** What a save asked for that an older server dropped silently, though the item is saved. */
export function vaultSaveDrops(
  sent: VaultSaveSent,
  saved: Partial<Pick<BotSecretMetadata, "policy" | "allBots" | "alsoOn" | "preview">>,
): VaultSaveDrop[] {
  const drops: VaultSaveDrop[] = [];
  // Allow is what a server without policies does anyway, so only Ask first and Block can be lost.
  if (sent.policy === "ask" && saved.policy !== "ask") drops.push("ask");
  else if (sent.policy === "off" && saved.policy === undefined) drops.push("block");
  if (sent.allBots === false && saved.allBots === undefined) drops.push("bots");
  if (sent.alsoOn && saved.alsoOn === undefined) drops.push("alsoOn");
  // A preview that couldn't be read says nothing of the key.
  if (hasAuthenticatorKey(sent.value) && saved.preview && !saved.preview.otp)
    drops.push("authenticatorKey");
  return drops;
}

// A short list: the counts already say how many, and a long export would bury the review.
const IMPORT_PROBLEMS_SHOWN = 5;

/** The left-out rows an import review lists, and how many more it only counts. */
export function vaultImportProblemList(problems: readonly VaultImportProblem[]): {
  shown: VaultImportProblem[];
  more: number;
} {
  return {
    shown: problems.slice(0, IMPORT_PROBLEMS_SHOWN),
    more: Math.max(0, problems.length - IMPORT_PROBLEMS_SHOWN),
  };
}
