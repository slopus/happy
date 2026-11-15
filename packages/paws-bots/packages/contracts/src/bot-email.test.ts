import { describe, expect, it } from "vitest";
import { BotEmailNameSchema, parseBotEmailName, suggestedEmailName } from "./bot-email.js";

describe("suggestedEmailName", () => {
  it("turns a bot name into an address name the server accepts", () => {
    for (const [name, expected] of [
      ["Research Helper", "research-helper"],
      ["Müller's Bot!", "muller-s-bot"],
      ["  Zoë  ", "zoe"],
    ] as const) {
      expect(suggestedEmailName(name)).toBe(expected);
      expect(BotEmailNameSchema.safeParse(suggestedEmailName(name)).success).toBe(true);
    }
  });

  it("drops what an address cannot hold", () => {
    expect(suggestedEmailName("研究")).toBe("");
    expect(suggestedEmailName("a".repeat(80))).toHaveLength(64);
    expect(suggestedEmailName("Support Bot")).toBe("");
  });
});

describe("parseBotEmailName", () => {
  it("names what is wrong with a name, or returns it ready to claim", () => {
    expect(parseBotEmailName(" Scout ")).toEqual({ name: "scout" });
    expect(parseBotEmailName("a")).toEqual({ problem: "length" });
    expect(parseBotEmailName("postmaster")).toEqual({ problem: "taken" });
    expect(parseBotEmailName("not ok!")).toEqual({ problem: "characters" });
  });

  it("keeps reserved names and their lookalikes for no bot", () => {
    for (const name of [
      "hello",
      "elie",
      "support.ts",
      "admin-bot",
      "help_desk",
      "rakazo",
      "rakazobot",
      "no-reply",
      "no-reply.bot",
      "mailer-daemon",
    ]) {
      expect(parseBotEmailName(name)).toEqual({ problem: "taken" });
    }
    for (const name of ["helper", "admiral", "hiker", "scout-team", "my-support"]) {
      expect(parseBotEmailName(name)).toEqual({ name });
    }
  });
});
