import { createStoredPreference } from "./stored-preference";

export const COMPOSER_ENTER_TO_SEND_STORAGE_KEY = "rakazo.composerEnterToSend";

function detectCoarsePointer(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

/** Default: Enter sends on desktop and inserts a newline on touch devices. */
export function defaultComposerEnterToSend(coarsePointer = detectCoarsePointer()): boolean {
  return !coarsePointer;
}

export function normalizeComposerEnterToSend(
  raw: string | null | undefined,
  coarsePointer: boolean = detectCoarsePointer(),
): boolean {
  if (raw == null) return defaultComposerEnterToSend(coarsePointer);
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return defaultComposerEnterToSend(coarsePointer);
}

export const composerEnterToSendPreference = createStoredPreference({
  key: COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  parse: (raw) => normalizeComposerEnterToSend(raw),
  serialize: (enterToSend) => (enterToSend ? "1" : "0"),
});
