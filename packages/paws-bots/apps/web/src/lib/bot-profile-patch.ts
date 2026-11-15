import { BOT_DESCRIPTION_MAX_LENGTH } from "@rakazo/contracts";

/** Instructions are edited separately; profile edits must preserve them. */
export function botProfilePatch(stored: string, next: string): { description?: string } {
  if (next === stored.trim()) return {};
  return { description: next.slice(0, BOT_DESCRIPTION_MAX_LENGTH) };
}
