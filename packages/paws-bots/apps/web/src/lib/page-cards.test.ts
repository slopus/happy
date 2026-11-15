import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { pageFrameHeight, projectPageCards } from "./page-cards";

type Message = { id: string; role: string; botId?: string; blocks: MessageBlock[] };

const page = (pageId: string, version: number): MessageBlock => ({
  kind: "page",
  pageId,
  version,
  title: `Page ${pageId}`,
});
const text = (value: string): MessageBlock => ({ kind: "text", text: value });

describe("projectPageCards", () => {
  it("folds a saved page into the same bot's next reply and marks older cards", () => {
    const messages: Message[] = [
      { id: "m1", role: "bot", botId: "b1", blocks: [page("p1", 1)] },
      { id: "m2", role: "bot", botId: "b1", blocks: [text("Made Page p1.")] },
      { id: "m3", role: "user", blocks: [text("change it")] },
      { id: "m4", role: "bot", botId: "b1", blocks: [page("p1", 2)] },
    ];
    const view = projectPageCards(messages);
    expect(view.visibleMessages.map((message) => message.id)).toEqual(["m2", "m3", "m4"]);
    expect(view.pages.get("m2")).toEqual([page("p1", 1)]);
    expect(view.foldedInto.get("m1")).toBe("m2");
    // The last page message has no reply after it yet, so it stays on its own.
    expect(view.isSuperseded("m2", page("p1", 1) as never)).toBe(true);
    expect(view.isSuperseded("m4", page("p1", 2) as never)).toBe(false);
  });

  it("never folds into another bot's reply or across the user's turn", () => {
    const messages: Message[] = [
      { id: "m1", role: "bot", botId: "b1", blocks: [page("p1", 1)] },
      { id: "m2", role: "bot", botId: "b2", blocks: [text("Hi.")] },
      { id: "m3", role: "bot", botId: "b1", blocks: [page("p2", 1)] },
      { id: "m4", role: "user", blocks: [text("ok")] },
      { id: "m5", role: "bot", botId: "b1", blocks: [text("Later.")] },
    ];
    const view = projectPageCards(messages);
    expect(view.visibleMessages).toHaveLength(5);
    expect(view.pages.size).toBe(0);
  });
});

describe("pageFrameHeight", () => {
  it("keeps the height a page asks for within what the viewer will draw", () => {
    expect(pageFrameHeight(1834)).toBe(1834);
    expect(pageFrameHeight(1e12)).toBe(200_000);
    expect(pageFrameHeight(-5)).toBe(0);
    expect(pageFrameHeight(Number.NaN)).toBe(0);
  });
});
