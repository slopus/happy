import { describe, expect, it, vi } from "vitest";

import {
  appendComposerDraftText,
  beginComposerDraftSubmission,
  composerDraftBindingsKey,
  composerDraftStorageKey,
  readComposerDraft,
  readComposerDraftBindings,
  settleComposerDraftSubmission,
  writeComposerDraft,
} from "./composer-draft.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("composer drafts", () => {
  it("scopes stored drafts per thread", () => {
    expect(composerDraftStorageKey("bot:1")).toBe("rakazo.composerDraft.bot:1");
    expect(composerDraftStorageKey("group:2")).toBe("rakazo.composerDraft.group:2");
  });

  it("round-trips a draft and clears the key when empty", () => {
    const storage = memoryStorage();
    expect(readComposerDraft("bot:1", storage)).toBe("");
    writeComposerDraft("bot:1", "hello @ada", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("hello @ada");
    expect(readComposerDraft("group:2", storage)).toBe("");
    writeComposerDraft("bot:1", "", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("");
  });

  it("tolerates missing storage", () => {
    expect(readComposerDraft("bot:1", null)).toBe("");
    expect(() => writeComposerDraft("bot:1", "hi", null)).not.toThrow();
  });
  it("keeps raw text and restores exact, versioned occurrence bindings", () => {
    const storage = memoryStorage();
    const bindings = [
      { start: 0, end: 4, mention: { kind: "bot" as const, id: "bot-bob", name: "Bob" } },
      { start: 9, end: 13, mention: { kind: "group" as const, id: "group-bob", name: "Bob" } },
    ];
    writeComposerDraft("thread", "@Bob and @Bob", storage, bindings);
    expect(storage.getItem(composerDraftStorageKey("thread"))).toBe("@Bob and @Bob");
    expect(readComposerDraftBindings("thread", storage)).toEqual(bindings);
    writeComposerDraft("thread", "@Bob and @Bob", storage);
    expect(readComposerDraftBindings("thread", storage)).toEqual(bindings);
    writeComposerDraft("thread", "new text", storage);
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
  });

  it("preserves legacy raw drafts and discards stale or unsupported metadata only", () => {
    const storage = memoryStorage({ [composerDraftStorageKey("thread")]: "@Bob" });
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
    for (const record of [
      { version: 1, text: "different", bindings: [] },
      { version: 2, text: "@Bob", bindings: [] },
    ]) {
      storage.setItem(composerDraftBindingsKey("thread"), JSON.stringify(record));
      expect(readComposerDraftBindings("thread", storage)).toEqual([]);
      expect(readComposerDraft("thread", storage)).toBe("@Bob");
      expect(storage.getItem(composerDraftBindingsKey("thread"))).toBeNull();
    }
    storage.setItem(composerDraftBindingsKey("thread"), "broken json");
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
    expect(readComposerDraft("thread", storage)).toBe("@Bob");
  });

  it("does not clear a newer same-text binding written by another tab when a send accepts", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const group = [
        { start: 0, end: 4, mention: { kind: "group" as const, id: "group", name: "Bob" } },
      ];
      const bot = [{ start: 0, end: 4, mention: { kind: "bot" as const, id: "bot", name: "Bob" } }];
      writeComposerDraft("thread", "@Bob", storage, group);
      const submitted = beginComposerDraftSubmission("thread", "@Bob");
      storage.setItem(
        composerDraftBindingsKey("thread"),
        JSON.stringify({ version: 1, text: "@Bob", bindings: bot }),
      );
      settleComposerDraftSubmission("thread", submitted, true);
      expect(readComposerDraft("thread", storage)).toBe("@Bob");
      expect(readComposerDraftBindings("thread", storage)).toEqual(bot);
      const accepted = beginComposerDraftSubmission("thread", "@Bob");
      settleComposerDraftSubmission("thread", accepted, true);
      expect(readComposerDraft("thread", storage)).toBe("");
      expect(storage.getItem(composerDraftBindingsKey("thread"))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a newer same-text binding from another tab when late words join an in-flight send", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const group = [
        { start: 0, end: 4, mention: { kind: "group" as const, id: "group", name: "Bob" } },
      ];
      const bot = [{ start: 0, end: 4, mention: { kind: "bot" as const, id: "bot", name: "Bob" } }];
      writeComposerDraft("thread", "@Bob", storage, group);
      const submitted = beginComposerDraftSubmission("thread", "@Bob");
      // Another tab binds the same text to another mention while the send is in flight.
      storage.setItem(
        composerDraftBindingsKey("thread"),
        JSON.stringify({ version: 1, text: "@Bob", bindings: bot }),
      );
      appendComposerDraftText("thread", "new words");
      settleComposerDraftSubmission("thread", submitted, true);
      expect(readComposerDraft("thread", storage)).toBe("@Bob new words");
      expect(readComposerDraftBindings("thread", storage)).toEqual(bot);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
