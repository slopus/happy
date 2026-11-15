import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  newestPageCards,
  pageCardSuperseded,
  pageLinksAsTitles,
  pageReply,
  pageReplyTargetId,
  uniquePages,
} from "./page-links.js";

describe("pageLinksAsTitles", () => {
  it("reads page links as their titles, leaving other, escaped and code links as written", () => {
    expect(
      pageLinksAsTitles(
        "I made a [Test dashboard](page:cm1) and [Q3 \\[draft\\]](page:p_2-x). See [docs](https://example.com) or [x](page:bad id).",
      ),
    ).toBe(
      "I made a Test dashboard and Q3 [draft]. See [docs](https://example.com) or [x](page:bad id).",
    );
    expect(pageLinksAsTitles("not a link: \\[a](page:b) but [c](page:d)")).toBe(
      "not a link: \\[a](page:b) but c",
    );
    expect(
      pageLinksAsTitles(
        "Use `[a](page:p1)` or ``[b](page:p2)``, see [c](page:p3).\n```md\n[d](page:p4)\n```\nand [e](page:p5) ` [f](page:p6)",
      ),
    ).toBe("Use `[a](page:p1)` or ``[b](page:p2)``, see c.\n```md\n[d](page:p4)\n```\nand e ` f");
    expect(pageLinksAsTitles("```\n[open](page:p1)")).toBe("```\n[open](page:p1)");
  });

  it("leaves tilde fences as written and keeps a backslash that escapes nothing", () => {
    expect(pageLinksAsTitles("~~~md\n[d](page:p4)\n~~~\nand [e](page:p5)")).toBe(
      "~~~md\n[d](page:p4)\n~~~\nand e",
    );
    expect(pageLinksAsTitles("~~~~\n~~~\n[d](page:p4)")).toBe("~~~~\n~~~\n[d](page:p4)");
    expect(pageLinksAsTitles("a ~~b~~ [c](page:p1)")).toBe("a ~~b~~ c");
    expect(pageLinksAsTitles("[C:\\Users \\[x\\]](page:p1)")).toBe("C:\\Users [x]");
    // A fence line with text after it opens a block but never closes one; trailing spaces may.
    expect(pageLinksAsTitles("```\n```js\n[d](page:p4)\n```  \n[e](page:p5)")).toBe(
      "```\n```js\n[d](page:p4)\n```  \ne",
    );
    expect(pageLinksAsTitles("~~~\n~~~x\n[d](page:p4)")).toBe("~~~\n~~~x\n[d](page:p4)");
    // CRLF line endings close a block like LF, and keep their bytes.
    for (const fence of ["```", "~~~"]) {
      expect(pageLinksAsTitles(`${fence}\r\n[d](page:p4)\r\n${fence} \r\n[e](page:p5)`)).toBe(
        `${fence}\r\n[d](page:p4)\r\n${fence} \r\ne`,
      );
      expect(pageLinksAsTitles(`${fence}\r\n${fence}x\r\n[d](page:p4)`)).toBe(
        `${fence}\r\n${fence}x\r\n[d](page:p4)`,
      );
    }
  });

  it("stays linear on 100 KB of brackets that never close", () => {
    for (const input of [
      "[".repeat(100_000),
      `[${"\\[".repeat(50_000)}`,
      `[${"\\]".repeat(50_000)}`,
      `[a](page:${"a".repeat(100_000)}`,
      "[a]".repeat(33_000),
      "` ".repeat(50_000),
      Array.from({ length: 400 }, (_, n) => `${"`".repeat(n + 1)}x`).join(""),
      `${"```\n".repeat(20_000)}`,
      `${"~~~\n".repeat(20_000)}`,
      // Long fences with text after them, which close nothing, over many short closers.
      `${"````x\n".repeat(20_000)}${"```\n".repeat(20_000)}`,
      // Fences getting shorter, then many short ones: each long fence looks past them all.
      `${Array.from({ length: 1_000 }, (_, n) => `${"`".repeat(1_003 - n)}\n`).join("")}${"```\n".repeat(50_000)}`,
    ]) {
      // Best of three under a generous bound, so a busy machine cannot fail it; a quadratic
      // input takes seconds.
      const runs = [0, 1, 2].map(() => {
        const started = performance.now();
        pageLinksAsTitles(input);
        return performance.now() - started;
      });
      expect(Math.min(...runs)).toBeLessThan(100);
    }
  });
});

describe("uniquePages", () => {
  it("lists a page once, where it first appeared, when the list shifted between two reads", () => {
    const page = (id: string, read: number) => ({ id, read });
    expect(uniquePages([page("a", 1), page("b", 1), page("b", 2), page("c", 2)])).toEqual([
      page("a", 1),
      page("b", 1),
      page("c", 2),
    ]);
  });
});

describe("pageCardSuperseded", () => {
  const card = (id: string, pageId: string, version: number) => ({
    id,
    blocks: [{ kind: "page" as const, pageId, version, title: "Plan" }],
  });

  it("marks a card older only when a later card in the thread shows the same page", () => {
    const thread = [card("m1", "p1", 1), card("m2", "p2", 1), card("m3", "p1", 2)];
    const newest = newestPageCards(thread);
    expect(pageCardSuperseded(newest, "m1", { pageId: "p1", version: 1 })).toBe(true);
    expect(pageCardSuperseded(newest, "m3", { pageId: "p1", version: 2 })).toBe(false);
    expect(pageCardSuperseded(newest, "m2", { pageId: "p2", version: 1 })).toBe(false);
    // A routine's refresh or another chat's edit saves a newer version with no card here.
    const alone = newestPageCards([card("m1", "p1", 1)]);
    expect(pageCardSuperseded(alone, "m1", { pageId: "p1", version: 1 })).toBe(false);
    // A card folded under the reply after it is that reply's card.
    const folded = newestPageCards(thread, (id) => (id === "m3" ? "m4" : id));
    expect(pageCardSuperseded(folded, "m4", { pageId: "p1", version: 2 })).toBe(false);
  });
});

describe("page replies", () => {
  const page = (pageId: string, version: number): MessageBlock => ({
    kind: "page",
    pageId,
    version,
    title: `Page ${pageId}`,
  });
  const text = (value: string): MessageBlock => ({ kind: "text", text: value });
  const messages = [
    { id: "m1", blocks: [page("p1", 1)] },
    { id: "m2", blocks: [page("p2", 1)] },
    { id: "m3", blocks: [text("hi"), page("p1", 2)] },
    { id: "progress:run-1", blocks: [page("p1", 3)] },
    { id: "m4", blocks: [text("later")] },
  ];

  it("picks the newest saved message holding the page, never a live one or another page", () => {
    expect(pageReplyTargetId(messages, "p1")).toBe("m3");
    expect(pageReplyTargetId(messages, "p2")).toBe("m2");
    expect(pageReplyTargetId(messages, "p9")).toBeNull();
  });

  it("replies to the page's card, else links the page, and keeps a reply the user picked", () => {
    expect(pageReply("B", messages, { id: "p2", title: "Older" })).toEqual({
      text: "B",
      replyToMessageId: "m2",
    });
    expect(pageReply("B", messages, { id: "p9", title: "Q3 [draft]" })).toEqual({
      text: "[Q3 \\[draft\\]](page:p9)\nB",
    });
    expect(pageReply("B", messages, { id: "p1", title: "Plan" }, "m4")).toEqual({ text: "B" });
    expect(pageReply("B", messages, null)).toEqual({ text: "B" });
  });
});
