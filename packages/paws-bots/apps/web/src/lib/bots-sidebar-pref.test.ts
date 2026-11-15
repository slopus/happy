import { describe, expect, it, vi } from "vitest";
import {
  botsSidebarCollapsedStorageKey,
  botsSidebarWidthStorageKey,
  clampBotsSidebarWidth,
  maximumBotsSidebarWidth,
  readBotsSidebarCollapsed,
  readBotsSidebarWidth,
  writeBotsSidebarCollapsed,
  writeBotsSidebarWidth,
} from "./bots-sidebar-pref";

describe("bots sidebar collapse preference", () => {
  it("builds a per-user storage key", () => {
    expect(botsSidebarCollapsedStorageKey(null)).toBeNull();
    expect(botsSidebarCollapsedStorageKey("user-1")).toBe("rakazo:bots-sidebar-collapsed:user-1");
  });

  it("reads and writes collapsed state", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    expect(readBotsSidebarCollapsed("user-1")).toBe(false);
    writeBotsSidebarCollapsed("user-1", true);
    expect(readBotsSidebarCollapsed("user-1")).toBe(true);
    writeBotsSidebarCollapsed("user-1", false);
    expect(readBotsSidebarCollapsed("user-1")).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("bots sidebar width preference", () => {
  it("remembers expanded widths independently for each user and clamps invalid limits", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    try {
      expect(readBotsSidebarWidth("first")).toBe(316);
      writeBotsSidebarWidth("first", 420);
      expect(readBotsSidebarWidth("first")).toBe(420);
      expect(readBotsSidebarWidth("second")).toBe(316);
      writeBotsSidebarWidth("second", 900);
      expect(readBotsSidebarWidth("second")).toBe(480);
      store.set(botsSidebarWidthStorageKey("first")!, "NaN");
      expect(readBotsSidebarWidth("first")).toBe(316);
      expect(maximumBotsSidebarWidth(768)).toBe(448);
      expect(clampBotsSidebarWidth(480, 768)).toBe(448);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows resizing without storage access", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("Storage unavailable");
      },
      setItem() {
        throw new Error("Storage unavailable");
      },
    });
    try {
      expect(readBotsSidebarWidth("user")).toBe(316);
      expect(() => writeBotsSidebarWidth("user", 400)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
