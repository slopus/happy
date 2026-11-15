import { t } from "@lingui/core/macro";
import { agentImportErrorReason } from "@rakazo/contracts";
import type { GrokBotExportErrorCode } from "@rakazo/core";
import { translateRunError } from "@rakazo/i18n/run-error";

function errorProvider(error: unknown): string {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
  const provider = data && typeof data === "object" && "provider" in data ? data.provider : "";
  return typeof provider === "string" && provider
    ? provider
    : translateRunError("Your model provider");
}

/** Localized copy for a refused import; undefined for other errors. */
export function agentImportErrorText(error: unknown): string | undefined {
  switch (agentImportErrorReason(error)) {
    case "selection_mismatch":
      return t`These files or choices no longer match. Choose the files again.`;
    case "cannot_run_here":
      return t`Something you chose cannot work here. Untick it and try again.`;
    case "model_needs_key":
      return t`Connect this model's provider first.`;
    case "instructions_too_long":
      return t`Instructions are too long. Untick some files.`;
    case "import_reused":
      return t`This import was already used. Choose the files again.`;
    case "name_just_taken":
      return t`Something with the same name was just added. Try again.`;
    case "key_rejected":
      // The same words, and translations, as when a connected key is rejected in a chat.
      return translateRunError("{provider} rejected the API key. Check your connection settings.", {
        provider: errorProvider(error),
      });
    case "key_unverified":
      return t`An imported API key could not be checked. Try again.`;
    case "key_check_failed":
      return t`An imported API key could not be used. Untick it and try again.`;
    default:
      return undefined;
  }
}

/** Why a Grok Bot's reply could not be read, and what to ask the Bot for. */
export function grokBotErrorText(code: GrokBotExportErrorCode): string {
  switch (code) {
    case "not_export":
      return t`That isn't a Grok Bot export. Paste the Bot's whole reply.`;
    case "cut_off":
      return t`The reply looks cut off. Ask the Bot for the rest, then paste both.`;
    case "too_large":
      return t`This export is too large to import.`;
    case "newer_version":
      return t`This export is newer than Rakazo can read. Update Rakazo and try again.`;
  }
}
