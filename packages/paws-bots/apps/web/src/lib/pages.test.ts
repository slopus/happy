import { describe, expect, it, vi } from "vitest";
import { createPageSession } from "./pages";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

const card = {
  id: "m1",
  blocks: [{ kind: "page" as const, pageId: "p1", version: 1, title: "Plan" }],
};

describe("page session", () => {
  it("replies to the open page's card unless the user picked a reply themselves", () => {
    const session = createPageSession();
    session.dock.set({ page: { id: "p1", title: "Plan" } });
    expect(session.send("bigger", [card])).toEqual({ text: "bigger", replyToMessageId: "m1" });
    expect(session.send("bigger", [card], "m0")).toEqual({ text: "bigger" });
    session.dock.set({ page: null });
    expect(session.send("bigger", [card])).toEqual({ text: "bigger" });
  });

  it("opens Share only on the page it was asked with, once", () => {
    const session = createPageSession();
    session.askShare("A");
    expect(session.takeShare("B")).toBe(false);
    expect(session.takeShare("A")).toBe(false);
    session.askShare("A");
    expect(session.takeShare("A")).toBe(true);
    // Back to the same page in history does not ask again.
    expect(session.takeShare("A")).toBe(false);
  });
});

describe("page replies", () => {
  it("hands a page's reply to the composer collapsed, only while a page is open", () => {
    const session = createPageSession();
    const received: string[] = [];
    const stop = session.subscribeReply((text) => received.push(text));
    session.offerReply("closed page");
    session.dock.set({ page: { id: "p1", title: "Plan" } });
    session.offerReply("  Watch   the\n shirt ");
    session.offerReply("   ");
    session.offerReply("x".repeat(301));
    session.offerReply({ text: "object" });
    session.offerReply("x".repeat(300));
    stop();
    session.offerReply("after unsubscribe");
    expect(received).toEqual(["Watch the shirt", "x".repeat(300)]);
  });
});
