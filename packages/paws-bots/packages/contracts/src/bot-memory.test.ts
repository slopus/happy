import { describe, expect, it } from "vitest";
import { initialBotMemory, isEmptyBotMemory } from "./bot-memory.js";

describe("empty bot memory", () => {
  it.each(["", " \n\t", initialBotMemory("Fixture"), initialBotMemory("Original name")])(
    "hides an empty or untouched index: %j",
    (content) => {
      expect(isEmptyBotMemory({ path: "MEMORY.md", content })).toBe(true);
    },
  );
  it.each([
    { path: "MEMORY.md", content: `${initialBotMemory("Fixture")}A remembered fact.\n` },
    { path: "MEMORY.md", content: "# A deliberate heading" },
    { path: "notes.md", content: initialBotMemory("Fixture") },
  ])("preserves authored content: %j", (doc) => {
    expect(isEmptyBotMemory(doc)).toBe(false);
  });
});
