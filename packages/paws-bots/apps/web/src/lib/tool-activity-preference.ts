import { createStoredPreference } from "./stored-preference";

export const TOOL_ACTIVITY_STORAGE_KEY = "rakazo.showToolActivity";

/** Only a saved "on" shows tool cards. Missing or unreadable storage stays off so chats stay clean. */
export function normalizeToolActivityEnabled(raw: string | null | undefined): boolean {
  return raw?.trim().toLowerCase() === "on";
}

export const toolActivityPreference = createStoredPreference({
  key: TOOL_ACTIVITY_STORAGE_KEY,
  parse: normalizeToolActivityEnabled,
  serialize: (enabled) => (enabled ? "on" : "off"),
});
