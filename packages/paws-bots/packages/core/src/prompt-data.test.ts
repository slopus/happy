import { describe, expect, it } from "vitest";
import { escapePromptData } from "./prompt-data.js";

describe("escapePromptData", () => {
  it("escapes delimiters and existing entities without changing quotes", () => {
    expect(escapePromptData("&<tag>\"quoted\" 'single' &lt;")).toBe(
      "&amp;&lt;tag&gt;\"quoted\" 'single' &amp;lt;",
    );
    expect(escapePromptData("")).toBe("");
    expect(escapePromptData("plain text")).toBe("plain text");
  });
});
