import { i18n } from "@lingui/core";
import type { VaultSaveDrop, VaultSaveSent } from "@rakazo/core";
import { secretAnswerRefusal, vaultImportProblemList, vaultSaveDrops } from "@rakazo/core";

/**
 * Vault text both apps show, kept here so the copy and its choice can't drift between them. Static
 * descriptors keep it in Lingui extraction.
 */

/** A secret answer's refusal, or `fallback`: its other errors could echo the value. */
export function secretAnswerErrorText(error: unknown, fallback: string): string {
  switch (secretAnswerRefusal(error)) {
    case "blocked":
      return i18n._({
        id: "This item is blocked for bots. Allow it in the Vault, or dismiss the request.",
        message: "This item is blocked for bots. Allow it in the Vault, or dismiss the request.",
      });
    case "unchosen":
      return i18n._({
        id: "This bot can't use this item. Change it in the Vault, or dismiss the request.",
        message: "This bot can't use this item. Change it in the Vault, or dismiss the request.",
      });
    default:
      return fallback;
  }
}

type VaultPolicy = NonNullable<VaultSaveSent["policy"]>;

/** What each policy is called, on the editor's control and the item. */
export function vaultPolicyLabels(): Record<VaultPolicy, string> {
  return {
    allow: i18n._({ id: "Allow", message: "Allow" }),
    ask: i18n._({ id: "Ask first", message: "Ask first" }),
    off: i18n._({ id: "Block", message: "Block" }),
  };
}

/**
 * Said under an account item's bots: that this Space can't use it, or, where there are other
 * Spaces, that a choice covers only this one's bots.
 */
export function vaultBotsNote(space: { ownVault: boolean; otherSpaces: boolean }) {
  if (space.ownVault) return ownVaultText();
  if (space.otherSpaces)
    return i18n._({
      id: "This limits only this Space's bots. Your other Spaces choose for their own.",
      message: "This limits only this Space's bots. Your other Spaces choose for their own.",
    });
  return undefined;
}

const ownVaultText = () =>
  i18n._({
    id: "This Space keeps its own vault, so its bots can't use account items.",
    message: "This Space keeps its own vault, so its bots can't use account items.",
  });

/**
 * What an item's details say of which bots may use it, the same on web and mobile, or "" when
 * every bot may. An account item seen from a Space that keeps its own vault is used by none of
 * that Space's bots, whatever was saved for it, so only that is said.
 */
export function vaultBotsLine(item: {
  /** False for a contact, which has no Allow or Block. */
  blockable: boolean;
  policy?: VaultPolicy;
  allBots?: boolean;
  botIds?: readonly string[];
  /** An account item, seen from a Space that keeps its own vault. */
  unusedHere: boolean;
  /** The chosen bots by name where the app names them: "loading" until read, "failed" if not. */
  chosen?: readonly string[] | "loading" | "failed";
}): string {
  if (item.unusedHere) return ownVaultText();
  const blocked = item.policy === "off";
  const policy =
    item.blockable && (blocked || item.policy === "ask") && item.policy
      ? vaultPolicyLabels()[item.policy]
      : "";
  const noBots = () => i18n._({ id: "No bots", message: "No bots" });
  const { chosen } = item;
  const bots =
    blocked || item.allBots !== false || chosen === "loading"
      ? ""
      : chosen === "failed"
        ? i18n._({
            id: "Could not load bots. Reload to try again.",
            message: "Could not load bots. Reload to try again.",
          })
        : chosen
          ? chosen.join(", ") || noBots()
          : item.botIds?.length
            ? i18n._({ id: "Chosen bots", message: "Chosen bots" })
            : noBots();
  return [policy, bots].filter(Boolean).join(" · ");
}

function dropText(drop: VaultSaveDrop): string {
  switch (drop) {
    case "ask":
      return i18n._({
        id: "Saved, but this server can't ask you first.",
        message: "Saved, but this server can't ask you first.",
      });
    case "block":
      return i18n._({
        id: "Saved, but this server can't block bots yet.",
        message: "Saved, but this server can't block bots yet.",
      });
    case "bots":
      return i18n._({
        id: "Saved, but this server can't limit an item to chosen bots.",
        message: "Saved, but this server can't limit an item to chosen bots.",
      });
    case "alsoOn":
      return i18n._({
        id: "Saved, but this server fills logins only on their own site.",
        message: "Saved, but this server fills logins only on their own site.",
      });
    case "authenticatorKey":
      return i18n._({
        id: "Saved, but this server can't keep authenticator keys yet.",
        message: "Saved, but this server can't keep authenticator keys yet.",
      });
  }
}

/** What an older server dropped from a save, or "" when it kept everything. */
export function vaultSaveNotice(...args: Parameters<typeof vaultSaveDrops>): string {
  return vaultSaveDrops(...args)
    .map(dropText)
    .join(" ");
}

/** An import's result labels, the reasons rows are left out, and why a file can't be used. */
export function vaultImportText() {
  const labels = {
    added: i18n._({ id: "Added", message: "Added" }),
    toAdd: i18n._({ id: "To add", message: "To add" }),
    duplicate: i18n._({ id: "Already saved", message: "Already saved" }),
    // A row the file has twice, before the import says what became of the first.
    repeat: i18n._({ id: "Repeated in the file", message: "Repeated in the file" }),
    notHttps: i18n._({ id: "Not on an HTTPS site", message: "Not on an HTTPS site" }),
    noPassword: i18n._({ id: "No password", message: "No password" }),
    full: i18n._({ id: "Vault full", message: "Vault full" }),
    notSaved: i18n._({ id: "Not saved", message: "Not saved" }),
  };
  return {
    labels,
    // Said in the review of logins about to be added, where no item's Bots setting is in sight.
    botsNote: i18n._({
      id: "Bots can use each imported login until you change its Bots setting.",
      message: "Bots can use each imported login until you change its Bots setting.",
    }),
    reasons: {
      notHttps: labels.notHttps,
      noPassword: labels.noPassword,
      duplicate: labels.duplicate,
      repeat: labels.repeat,
      invalid: labels.notSaved,
      limit: labels.full,
    },
    fileProblems: {
      too_large: i18n._({
        id: "This file is too large to import.",
        message: "This file is too large to import.",
      }),
      unreadable: i18n._({
        id: "This file can't be read as CSV.",
        message: "This file can't be read as CSV.",
      }),
      no_logins: i18n._({
        id: "No website and password columns found.",
        message: "No website and password columns found.",
      }),
    },
  };
}

/** An import review's left-out rows, one line each by row and site, never by username. */
export function vaultImportProblemLines(
  problems: Parameters<typeof vaultImportProblemList>[0],
): string[] {
  const { reasons } = vaultImportText();
  const { shown, more } = vaultImportProblemList(problems);
  return [
    ...shown.map(({ line, label, reason }) =>
      [
        i18n._({ id: "Row {line}", message: "Row {line}", values: { line } }),
        label,
        reasons[reason],
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    ...(more > 0
      ? [i18n._({ id: "And {more} more", message: "And {more} more", values: { more } })]
      : []),
  ];
}
