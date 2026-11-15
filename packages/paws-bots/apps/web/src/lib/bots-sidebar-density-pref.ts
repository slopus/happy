import { createStoredPreference } from "./stored-preference";

export type BotsSidebarDensity = "comfortable" | "compact";

export const BOTS_SIDEBAR_DENSITY_STORAGE_KEY = "rakazo.botsSidebarDensity";

export function normalizeBotsSidebarDensity(raw: string | null | undefined): BotsSidebarDensity {
  return raw?.trim().toLowerCase() === "compact" ? "compact" : "comfortable";
}

export const botsSidebarDensityPreference = createStoredPreference<BotsSidebarDensity>({
  key: BOTS_SIDEBAR_DENSITY_STORAGE_KEY,
  parse: normalizeBotsSidebarDensity,
  serialize: normalizeBotsSidebarDensity,
});
