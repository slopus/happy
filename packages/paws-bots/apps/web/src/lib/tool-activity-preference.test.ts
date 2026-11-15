import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeToolActivityEnabled,
  TOOL_ACTIVITY_STORAGE_KEY,
} from "./tool-activity-preference";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("tool activity preference", () => {
  it("stays off unless a saved choice turns it on", () => {
    expect(normalizeToolActivityEnabled("on")).toBe(true);
    expect(normalizeToolActivityEnabled("ON")).toBe(true);
    expect(normalizeToolActivityEnabled(" on ")).toBe(true);
    expect(normalizeToolActivityEnabled("off")).toBe(false);
    expect(normalizeToolActivityEnabled("OFF")).toBe(false);
    expect(normalizeToolActivityEnabled(null)).toBe(false);
    expect(normalizeToolActivityEnabled(undefined)).toBe(false);
    expect(normalizeToolActivityEnabled("")).toBe(false);
    expect(normalizeToolActivityEnabled("nonsense")).toBe(false);
  });

  it("saves the choice as on or off", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    const { toolActivityPreference } = await import("./tool-activity-preference");
    expect(toolActivityPreference.get()).toBe(false);
    toolActivityPreference.set(false);
    expect(store.get(TOOL_ACTIVITY_STORAGE_KEY)).toBe("off");
    toolActivityPreference.set(true);
    expect(store.get(TOOL_ACTIVITY_STORAGE_KEY)).toBe("on");
  });

  it("reads a saved choice", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === TOOL_ACTIVITY_STORAGE_KEY ? "on" : null),
      setItem: () => undefined,
    });
    const { toolActivityPreference } = await import("./tool-activity-preference");
    expect(toolActivityPreference.get()).toBe(true);
  });
});
