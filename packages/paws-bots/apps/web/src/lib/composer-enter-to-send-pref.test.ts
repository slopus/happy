import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComposerEnterToSendPref from "./composer-enter-to-send-pref.js";

import {
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  defaultComposerEnterToSend,
  normalizeComposerEnterToSend,
} from "./composer-enter-to-send-pref.js";

let mod: typeof ComposerEnterToSendPref;

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./composer-enter-to-send-pref.js");
});

describe("defaultComposerEnterToSend", () => {
  it("defaults to sending on desktop and newline on touch", () => {
    expect(defaultComposerEnterToSend(false)).toBe(true);
    expect(defaultComposerEnterToSend(true)).toBe(false);
  });
});

describe("normalizeComposerEnterToSend", () => {
  it("parses stored flags", () => {
    expect(normalizeComposerEnterToSend("1")).toBe(true);
    expect(normalizeComposerEnterToSend("0")).toBe(false);
    expect(normalizeComposerEnterToSend("true")).toBe(true);
    expect(normalizeComposerEnterToSend("off")).toBe(false);
  });

  it("falls back to the device default for missing or unknown values", () => {
    expect(normalizeComposerEnterToSend(null, false)).toBe(true);
    expect(normalizeComposerEnterToSend(null, true)).toBe(false);
    expect(normalizeComposerEnterToSend("maybe", false)).toBe(true);
    expect(normalizeComposerEnterToSend("maybe", true)).toBe(false);
  });
});

describe("composerEnterToSendPreference", () => {
  function stubPointer(coarsePointer: boolean) {
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: coarsePointer }),
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])("reads the device default with coarse pointer %s", (coarsePointer) => {
    stubPointer(coarsePointer);
    vi.stubGlobal("localStorage", memoryStorage());
    expect(mod.composerEnterToSendPreference.get()).toBe(!coarsePointer);
  });

  it.each([false, true])("uses the detected pointer without storage: %s", (coarsePointer) => {
    stubPointer(coarsePointer);
    vi.stubGlobal("localStorage", undefined);
    expect(mod.composerEnterToSendPreference.get()).toBe(!coarsePointer);
    expect(window.matchMedia).toHaveBeenCalledWith("(pointer: coarse)");
  });

  it.each([
    [false, "0", false],
    [true, "1", true],
  ] as const)("stored preference overrides coarse pointer %s", (coarsePointer, raw, expected) => {
    stubPointer(coarsePointer);
    vi.stubGlobal("localStorage", memoryStorage({ [COMPOSER_ENTER_TO_SEND_STORAGE_KEY]: raw }));
    expect(mod.composerEnterToSendPreference.get()).toBe(expected);
  });

  it("saves the toggle as 1 or 0", () => {
    stubPointer(false);
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(mod.composerEnterToSendPreference.get()).toBe(true);
    mod.composerEnterToSendPreference.set(false);
    expect(mod.composerEnterToSendPreference.get()).toBe(false);
    expect(storage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("0");
    mod.composerEnterToSendPreference.set(true);
    expect(storage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("1");
  });
});
