import { RESPONSE_STREAMING_STORAGE_KEY } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("response streaming preference", () => {
  it("leaves streaming off until a saved choice turns it on", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    });
    const { responseStreamingPreference } = await import("./response-streaming");
    expect(responseStreamingPreference.get()).toBe(false);
    responseStreamingPreference.set(true);
    expect(store.get(RESPONSE_STREAMING_STORAGE_KEY)).toBe("on");
    responseStreamingPreference.set(false);
    expect(store.get(RESPONSE_STREAMING_STORAGE_KEY)).toBe("off");
  });

  it("reads a saved choice", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === RESPONSE_STREAMING_STORAGE_KEY ? "on" : null),
      setItem: () => undefined,
    });
    const { responseStreamingPreference } = await import("./response-streaming");
    expect(responseStreamingPreference.get()).toBe(true);
  });
});
