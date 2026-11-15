import { describe, expect, it } from "vitest";
import { parseAgentImport } from "./index.js";

// A heading layout like the document the import prompt asks another assistant for.
const headed = "# Instructions\nBe brief.\n\n# Memory\n- Likes tea.\n\n# Skills\nNone yet.\n";

describe("a single file with document headings", () => {
  it("is still read as the agent file it is", () => {
    const result = parseAgentImport([{ path: "workspace/SOUL.md", content: headed }]);
    if ("error" in result) throw new Error(result.error);
    expect(result.source).not.toBe("document");
    expect(result.instructions.map((item) => item.content)).toEqual([headed]);
  });

  it("is still read as Hermes memory under memories/", () => {
    const result = parseAgentImport([{ path: ".hermes/memories/MEMORY.md", content: headed }]);
    if ("error" in result) throw new Error(result.error);
    expect(result.source).toBe("hermes");
  });

  it("is a document when it is the pasted reply or another file", () => {
    for (const path of ["agent.md", "notes/export.md"]) {
      const result = parseAgentImport([{ path, content: headed }]);
      if ("error" in result) throw new Error(result.error);
      expect(result.source, path).toBe("document");
    }
  });
});
