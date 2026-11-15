import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOTS_SIDEBAR_DENSITY_STORAGE_KEY,
  normalizeBotsSidebarDensity,
} from "./bots-sidebar-density-pref";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadPreference() {
  return (await import("./bots-sidebar-density-pref")).botsSidebarDensityPreference;
}

describe("bot sidebar density preference", () => {
  it("defaults to Comfortable and accepts only Compact as the compact value", async () => {
    expect(BOTS_SIDEBAR_DENSITY_STORAGE_KEY).toBe("rakazo.botsSidebarDensity");
    expect(normalizeBotsSidebarDensity(null)).toBe("comfortable");
    expect(normalizeBotsSidebarDensity("unknown")).toBe("comfortable");
    expect(normalizeBotsSidebarDensity(" COMPACT ")).toBe("compact");
    expect(normalizeBotsSidebarDensity("comfortable")).toBe("comfortable");
    vi.stubGlobal("localStorage", undefined);
    expect((await loadPreference()).get()).toBe("comfortable");
  });

  it.each([
    ["compact", "compact"],
    ["unexpected", "comfortable"],
  ] as const)("reads saved %s as %s", async (saved, expected) => {
    vi.stubGlobal("localStorage", { getItem: () => saved, setItem: () => undefined });
    expect((await loadPreference()).get()).toBe(expected);
  });

  it("updates subscribers and persists a choice", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const preference = await loadPreference();
    const listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);

    expect(preference.get()).toBe("comfortable");
    expect(preference.set("compact")).toBe("compact");
    expect(preference.get()).toBe("compact");
    expect(store.get(BOTS_SIDEBAR_DENSITY_STORAGE_KEY)).toBe("compact");
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    preference.set("comfortable");
    expect(store.get(BOTS_SIDEBAR_DENSITY_STORAGE_KEY)).toBe("comfortable");
    expect(listener).toHaveBeenCalledOnce();
  });
});
