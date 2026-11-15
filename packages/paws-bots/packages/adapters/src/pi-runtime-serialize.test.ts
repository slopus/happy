import { describe, expect, it } from "vitest";
import { serializeToolResult } from "./pi-runtime-tools.js";

describe("serializeToolResult", () => {
  const skill = {
    name: "large-skill",
    description: "Large skill",
    source: "user",
    readOnly: false,
    content: `---\nname: large-skill\n---\n${"1. Step kept for skill_update.\n".repeat(600)}`,
  };

  it.each(["current", "retrieval"] as const)(
    "returns a large skill read verbatim with the %s strategy",
    (strategy) => {
      const text = serializeToolResult(skill, strategy, "skill_read", { name: skill.name });
      expect(text.length).toBeGreaterThan(12_000);
      expect(JSON.parse(text)).toEqual(skill);
    },
  );

  it.each(["current", "retrieval"] as const)(
    "keeps a full child read and its version with %s context",
    (strategy) => {
      const listing = {
        bot: { id: "child", instructionsVersion: "v2", instructions: "x".repeat(20_000) },
        bots: [],
        groups: [],
        sections: [],
        truncated: false,
      };
      expect(
        JSON.parse(serializeToolResult(listing, strategy, "list_fleet", { bot_id: "child" })),
      ).toEqual(listing);
    },
  );

  it.each(["current", "retrieval"] as const)(
    "passes every page of a settings read whole with the %s strategy",
    (strategy) => {
      const settingsPage = (instructions: string, offset: number, next: number | null) => ({
        name: "Bot",
        description: "",
        instructions,
        instructionsLength: 19_000,
        instructionsOffset: offset,
        instructionsNextOffset: next,
        avatar: "#8B5CF6",
        notifyOnFinish: false,
        dailyCheckIns: false,
        model: "Test Model (default)",
        thinkingLevel: "default",
        readAloud: false,
        voice: "default",
        models: [{ provider: "Test", ids: ["test/model-a", "test/model-b"], more: 3 }],
        thinkingLevels: ["low", "medium", "high"],
      });
      const text = "x".repeat(19_000);
      const pages = [
        settingsPage(text.slice(0, 8_000), 0, 8_000),
        settingsPage(text.slice(8_000, 16_000), 8_000, 16_000),
        settingsPage(text.slice(16_000), 16_000, null),
      ];
      for (const page of pages) {
        const serialized = serializeToolResult(page, strategy, "update_bot", {
          ...(page.instructionsOffset > 0 ? { instructions_offset: page.instructionsOffset } : {}),
        });
        expect(JSON.parse(serialized)).toEqual(page);
        expect(serialized.length).toBeLessThan(12_000);
      }
      expect(pages.map((page) => page.instructions).join("")).toBe(text);
    },
  );

  it("returns an opted-in MCP result verbatim", () => {
    const message = {
      body: `${"x".repeat(8_000)}https://sessions.example.test/join/abc${"y".repeat(8_000)}`,
    };
    const text = serializeToolResult(
      message,
      "retrieval",
      "mcp__mail__get_message",
      {},
      {
        ids: ["srv_mail"],
        slugs: ["mail"],
      },
    );
    expect(JSON.parse(text)).toEqual(message);
  });

  it("still bounds other large tool results", () => {
    const text = serializeToolResult({ output: "x".repeat(20_000) }, "current", "shell", {});
    expect(text.length).toBeLessThan(20_000);
  });
});
