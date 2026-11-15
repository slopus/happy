import { describe, expect, it } from "vitest";
import { promptVersion, promptVersionOf, promptVersionParts } from "./prompt-version.js";

const PROMPT_VERSION = promptVersion();

describe("prompt version", () => {
  it("is a short hash that is the same on every call", () => {
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(promptVersionOf(promptVersionParts())).toBe(PROMPT_VERSION);
    expect(promptVersion()).toBe(PROMPT_VERSION);
    expect(promptVersionOf(promptVersionParts())).toBe(promptVersionOf(promptVersionParts()));
  });

  it("changes when a template or the history format changes", () => {
    const parts = promptVersionParts();
    expect(promptVersionOf({ ...parts, computerUse: `${parts.computerUse} ` })).not.toBe(
      PROMPT_VERSION,
    );
    const [first, ...rest] = parts.tools;
    const schemaChanged = [first![0], first![1], { ...(first![2] as object), extra: true }];
    expect(promptVersionOf({ ...parts, tools: [schemaChanged, ...rest] })).not.toBe(PROMPT_VERSION);
    expect(promptVersionOf({ ...parts, historyFormat: parts.historyFormat + 1 })).not.toBe(
      PROMPT_VERSION,
    );
    expect(
      promptVersionOf({
        ...parts,
        context: { ...parts.context, recentToolResultsToKeep: 99 },
      }),
    ).not.toBe(PROMPT_VERSION);
  });

  it("renders the full system prompt templates", () => {
    const text = JSON.stringify(promptVersionParts());
    expect(text).toContain("Prefer tools over claiming you already did the work.");
    expect(text).toContain("reply_target");
  });
});
