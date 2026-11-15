// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { lastSelectedText } from "./quote-selection.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const messageIdOf = (node: Node) =>
  (node instanceof Element ? node : node.parentElement)
    ?.closest("[data-quote-message-id]")
    ?.getAttribute("data-quote-message-id");

const paragraph = (index: number) => document.querySelectorAll("p")[index]!.firstChild!;

function rangeOver(start: Node, end: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, endOffset);
  return range;
}

const botMessage = (id: string, ...paragraphs: string[]) =>
  `<div data-message-id="${id}"><div data-quote-message-id="${id}">${paragraphs
    .map((text) => `<p>${text}</p>`)
    .join("")}</div><div><button aria-label="React"><svg></svg></button></div></div>`;

describe("lastSelectedText", () => {
  it("keeps a triple-clicked last paragraph of the latest message inside it", () => {
    document.body.innerHTML = `<main>${botMessage("m1", "first", "last")}</main><div><div role="status" class="sr-only"></div><textarea></textarea></div>`;
    const range = rangeOver(paragraph(1), document.querySelector('[role="status"]')!, 0);
    expect(messageIdOf(lastSelectedText(range))).toBe("m1");
  });

  it("keeps a triple-clicked last paragraph inside its message when another follows", () => {
    document.body.innerHTML = `<main>${botMessage("m1", "first", "last")}${botMessage("m2", "next")}</main>`;
    const range = rangeOver(paragraph(1), paragraph(2), 0);
    expect(messageIdOf(lastSelectedText(range))).toBe("m1");
  });

  it("uses the text before an element boundary", () => {
    document.body.innerHTML = `<main>${botMessage("m1", "body")}<span>x</span></main>`;
    const range = rangeOver(paragraph(0), document.querySelector("main")!, 1);
    expect(messageIdOf(lastSelectedText(range))).toBe("m1");
  });

  it("returns a text end container that has selected text", () => {
    document.body.innerHTML = "<p>body</p>";
    const range = rangeOver(paragraph(0), paragraph(0), 2);
    expect(lastSelectedText(range)).toBe(paragraph(0));
  });
});
