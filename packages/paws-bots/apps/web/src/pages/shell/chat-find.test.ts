// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findTextRanges, sameStart } from "./chat-find";

function transcript(...messages: string[]) {
  const root = document.createElement("div");
  root.innerHTML = messages
    .map((html, index) => `<div data-message-id="m${index}">${html}</div>`)
    .join("");
  return root;
}

function found(root: ParentNode, query: string) {
  return findTextRanges(root, query).map((range) => range.toString());
}

describe("findTextRanges", () => {
  it("finds every match across messages, ignoring case", () => {
    const root = transcript(
      "<p>Deploy the <b>deploy</b> script</p>",
      "<p>DEPLOYED and redeploy</p>",
    );
    expect(found(root, "deploy")).toEqual(["Deploy", "deploy", "DEPLOY", "deploy"]);
  });

  it("matches a phrase that crosses a link or bold text", () => {
    const root = transcript('<p>see the <a href="#">release notes</a> today</p>');
    expect(found(root, "the release")).toEqual(["the release"]);
    expect(found(root, "notes today")).toEqual(["notes today"]);
  });

  it("never joins the end of one paragraph to the start of the next", () => {
    expect(found(transcript("<p>alpha</p><p>beta</p>"), "alphabeta")).toEqual([]);
  });

  it("treats any run of whitespace as one space", () => {
    const root = transcript("<p>alpha\n  beta</p>", "<pre>one  two</pre>");
    expect(found(root, "alpha beta")).toEqual(["alpha\n  beta"]);
    expect(found(root, "alpha   beta")).toEqual(["alpha\n  beta"]);
    expect(found(root, "one two")).toEqual(["one  two"]);
    expect(found(root, "one  two")).toEqual(["one  two"]);
  });

  it("never joins words across a line break", () => {
    const root = transcript("<p>hello<br>world</p>");
    expect(found(root, "helloworld")).toEqual([]);
    expect(found(root, "world")).toEqual(["world"]);
  });

  it("keeps searching text whose lowercase is longer", () => {
    // İ lowercases to two code units.
    const root = transcript("<p>İstanbul trip plan</p>");
    expect(found(root, "trip")).toEqual(["trip"]);
    expect(found(root, "İstanbul")).toEqual(["İstanbul"]);
  });

  it("matches Greek text whose sigma takes its final form", () => {
    const root = transcript("<p>ΟΣ and οσ and ος</p>");
    expect(found(root, "ΟΣ")).toEqual(["ΟΣ", "οσ", "ος"]);
  });

  it("only searches message text, not buttons, hidden text or other transcript chrome", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<button>Load earlier messages</button><div data-message-id="m"><p>messages here</p><button>Copy messages</button><span aria-hidden="true">messages</span></div>';
    expect(found(root, "messages")).toEqual(["messages"]);
  });

  it("never joins words across an inline image", () => {
    const root = transcript('<p>left<img alt="" src="x.png">right</p>');
    expect(found(root, "leftright")).toEqual([]);
  });

  it("never joins the text either side of a button", () => {
    const root = transcript("<p>before <button>Page</button> after</p>");
    expect(found(root, "before after")).toEqual([]);
    expect(found(root, "after")).toEqual(["after"]);
  });

  it("does not count overlapping matches twice", () => {
    expect(findTextRanges(transcript("aaaa"), "aa")).toHaveLength(2);
  });

  it("finds nothing for an empty or blank query", () => {
    const root = transcript("<p>hello</p>");
    expect(findTextRanges(root, "")).toEqual([]);
    expect(findTextRanges(root, "  ")).toEqual([]);
  });

  it("recognizes the same match in a fresh search after older messages load", () => {
    const root = transcript("<p>one target</p>");
    const [before] = findTextRanges(root, "target");
    root.insertAdjacentHTML("afterbegin", '<div data-message-id="old"><p>old target</p></div>');
    const after = findTextRanges(root, "target");
    expect(after).toHaveLength(2);
    expect(after.findIndex((range) => before && sameStart(range, before))).toBe(1);
  });
});
