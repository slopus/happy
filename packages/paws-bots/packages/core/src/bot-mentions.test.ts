import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { projectBotMentions } from "./bot-mentions.js";

const created: MessageBlock = {
  kind: "child_bot",
  botId: "child",
  name: "Planner",
  status: "created",
};
const bot = (id: string, blocks: MessageBlock[], botId = "chief") => ({
  id,
  role: "bot",
  botId,
  blocks,
});
const text = (value: string): MessageBlock => ({ kind: "text", text: value });

describe("projectBotMentions", () => {
  it("folds an announcement into the same bot's next reply, past tool activity", () => {
    const view = projectBotMentions([
      bot("a", [created]),
      bot("b", [{ kind: "steps", steps: [] }]),
      bot("c", [text("Planner is ready.")]),
    ]);
    expect(view.visibleMessages.map((message) => message.id)).toEqual(["b", "c"]);
    expect(view.mentions.get("c")).toEqual([created]);
    expect(view.foldedInto.get("a")).toBe("c");
  });

  it("keeps an announcement with no reply from that bot yet", () => {
    for (const messages of [
      [bot("a", [created])],
      [bot("a", [created]), { id: "u", role: "user", blocks: [text("thanks")] }],
      [bot("a", [created]), bot("b", [text("hi")], "other")],
    ]) {
      const view = projectBotMentions(messages);
      expect(view.visibleMessages[0]?.id).toBe("a");
      expect(view.mentions.size).toBe(0);
    }
  });

  it("leaves an announcement alongside other content in place", () => {
    const view = projectBotMentions([
      bot("a", [created, text("Made it.")]),
      bot("b", [text("ok")]),
    ]);
    expect(view.visibleMessages.map((message) => message.id)).toEqual(["a", "b"]);
    expect(view.mentions.size).toBe(0);
  });

  it("keeps archive and delete notices with their status", () => {
    const archived: MessageBlock = { ...created, status: "archived" } as MessageBlock;
    const view = projectBotMentions([bot("a", [archived]), bot("b", [text("Done.")])]);
    expect(view.visibleMessages.map((message) => message.id)).toEqual(["a", "b"]);
    expect(view.mentions.size).toBe(0);
  });
});
