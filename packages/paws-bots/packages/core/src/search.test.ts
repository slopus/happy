import type { SearchHit } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeSearchHits,
  escapeJsonSearchWildcards,
  escapeSearchWildcards,
  extractLinksFromText,
  matchesSearchQuery,
  searchHitListKey,
  searchHitThreadTarget,
  snippetAroundMatch,
} from "./search.js";

describe("search helpers", () => {
  it("extracts http and https links from text", () => {
    expect(extractLinksFromText("see https://example.com/docs and http://test.local/x.")).toEqual([
      "https://example.com/docs",
      "http://test.local/x",
    ]);
  });

  it.each(["`", "``", "```"])("excludes %s code delimiters and deduplicates links", (delimiter) => {
    const url = "https://example.com/docs";
    expect(extractLinksFromText(`${url} ${delimiter}${url}${delimiter}`)).toEqual([url]);
  });

  it("separates adjacent code links and preserves encoded backticks", () => {
    expect(extractLinksFromText("`https://example.com/a``http://example.com/%60b`")).toEqual([
      "https://example.com/a",
      "http://example.com/%60b",
    ]);
  });

  it("ignores a bare scheme before a code delimiter", () => {
    expect(extractLinksFromText("`https://` https://example.com/a)https://`")).toEqual([
      "https://example.com/a",
    ]);
  });

  it.each([
    "https://[2001:db8::1]/guide",
    "http://[::1]:8080/guide?q=search#part",
    "https://[::ffff:192.0.2.1]:8443/guide",
    "https://[2001:db8::1]",
  ])("keeps the complete IPv6 URL %s", (url) => {
    expect(extractLinksFromText(`see ${url}.`)).toEqual([url]);
  });

  it.each([
    "[https://[2001:db8::1]/guide]",
    "[docs](https://[2001:db8::1]/guide)",
    "([docs](https://[2001:db8::1]/guide)).",
  ])("keeps IPv6 brackets inside a wrapped link: %s", (text) => {
    expect(extractLinksFromText(text)).toEqual(["https://[2001:db8::1]/guide"]);
  });

  it("stops at unmatched closing square brackets and keeps adjacent links", () => {
    expect(
      extractLinksFromText("[https://example.com/guide],[https://[2001:db8::1]/guide]"),
    ).toEqual(["https://example.com/guide", "https://[2001:db8::1]/guide"]);
  });

  it("keeps balanced parentheses and square brackets in the same URL", () => {
    expect(extractLinksFromText("[docs](https://[2001:db8::1]/a_(b))")).toEqual([
      "https://[2001:db8::1]/a_(b)",
    ]);
  });

  it("ignores a bare scheme before an unmatched closing square bracket", () => {
    expect(extractLinksFromText("https://]")).toEqual([]);
    expect(extractLinksFromText("[https://example.com/guide]https://]")).toEqual([
      "https://example.com/guide",
    ]);
  });

  it("keeps balanced parentheses inside a link", () => {
    expect(
      extractLinksFromText(
        "read https://en.wikipedia.org/wiki/Rust_(programming_language), or (see https://example.com/docs).",
      ),
    ).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      "https://example.com/docs",
    ]);
    expect(extractLinksFromText("(https://example.com/a_(b)).")).toEqual([
      "https://example.com/a_(b)",
    ]);
    expect(
      extractLinksFromText("**[docs](https://example.com/docs)** and ((https://x.test/y)))"),
    ).toEqual(["https://example.com/docs", "https://x.test/y"]);
  });

  it("keeps adjacent wrapped links", () => {
    expect(extractLinksFromText("(https://example.com/a),(https://example.com/b)")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("ignores a bare scheme after an unmatched closing parenthesis", () => {
    expect(extractLinksFromText("https://example.com/docs)https://")).toEqual([
      "https://example.com/docs",
    ]);
  });

  it.each([
    ["(https://x.test/),", "https://x.test/"],
    ["[https://[2001:db8::1]/guide],", "https://[2001:db8::1]/guide"],
  ])("handles thousands of adjacent wrapped links without recursing: %s", (wrapped, url) => {
    expect(extractLinksFromText(wrapped.repeat(50_000))).toEqual([url]);
  });

  it("matches case-insensitive substrings", () => {
    expect(matchesSearchQuery("Venue", "Research venues")).toBe(true);
    expect(matchesSearchQuery("missing", "Research venues")).toBe(false);
  });

  it("escapes the characters a SQL LIKE pattern treats as wildcards", () => {
    expect(escapeSearchWildcards("50% off")).toBe("50\\% off");
    expect(escapeSearchWildcards("under_score")).toBe("under\\_score");
    expect(escapeSearchWildcards("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves a query without wildcards untouched", () => {
    expect(escapeSearchWildcards("venue")).toBe("venue");
    expect(escapeSearchWildcards("")).toBe("");
  });

  it.each([
    [String.raw`back\slash`, String.raw`back\\\\slash`],
    ['say "hi"', String.raw`say \\"hi\\"`],
    ["50%_off", String.raw`50\%\_off`],
    ["line\nbreak", String.raw`line\\nbreak`],
    ["venue", "venue"],
    ["café/東京", "café/東京"],
    ["\b\f\r\t\u0001", String.raw`\\b\\f\\r\\t\\u0001`],
  ])("escapes %j for a JSONB text LIKE pattern", (query, expected) => {
    expect(escapeJsonSearchWildcards(query)).toBe(expected);
  });

  it("builds a short snippet around the query", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    expect(snippetAroundMatch(text, "gamma", 20)).toContain("gamma");
  });

  it("opens at a word instead of in the middle of one", () => {
    const text =
      "**Checklist** with *italic* and `code`.\n\nThe unique search phrase is marigold checklist.";
    expect(snippetAroundMatch(text, "marigold")).toBe(
      "…`code`.\n\nThe unique search phrase is marigold checklist.",
    );
  });

  it("keeps the match after characters that expand when lowercased", () => {
    const text = `${"İ".repeat(50)} needle result details`;
    expect(matchesSearchQuery("needle", text)).toBe(true);
    expect(snippetAroundMatch(text, " NEEDLE ")).toBe(`…${"İ".repeat(39)} needle result details`);
  });

  it("preserves snippet bounds and original casing after lowercase expansion", () => {
    const text = `${"İ😀".repeat(50)} NeEdLe ${"tail ".repeat(30)}`;
    const index = text.indexOf("NeEdLe");
    expect(snippetAroundMatch(text, "needle")).toBe(`…${text.slice(index - 40, index + 80)}…`);
  });

  it.each(["i", "\u0307", "i\u0307"])(
    "maps a match within an expanded character back to that character: %j",
    (query) => {
      const text = `${"x".repeat(80)}İ result details`;
      expect(matchesSearchQuery(query, text)).toBe(true);
      expect(snippetAroundMatch(text, query)).toBe(`…${"x".repeat(40)}İ result details`);
    },
  );

  it("retains whole-string lowercase matching for contextual characters", () => {
    const text = `${"İ".repeat(50)} ΟΣ result details`;
    expect(matchesSearchQuery("ος", text)).toBe(true);
    expect(snippetAroundMatch(text, "ος")).toBe(`…${"İ".repeat(39)} ΟΣ result details`);
  });

  it.each(["", "   ", "missing"])("keeps the leading fallback for %j", (query) => {
    const text = "İ".repeat(150);
    expect(snippetAroundMatch(text, query)).toBe(text.slice(0, 120));
  });

  it.each(["😀", "𠀀"])("keeps %s whole at the start of a matching snippet", (character) => {
    const text = `xxxxx${character}${"a".repeat(39)}needle`;
    const snippet = snippetAroundMatch(text, "needle");
    expect(snippet).toBe(`…${character}${"a".repeat(39)}needle`);
    expect(snippet).not.toMatch(/[\ud800-\udfff]/u);
  });

  it.each(["😀", "𠀀"])("keeps %s whole at the end of a matching snippet", (character) => {
    const prefix = `needle${"a".repeat(113)}`;
    const snippet = snippetAroundMatch(`${prefix}${character}z`, "needle");
    expect(snippet).toBe(`${prefix}…`);
    expect(snippet).not.toMatch(/[\ud800-\udfff]/u);
  });

  it.each(["", "   ", "missing"])("keeps the leading fallback well formed for %j", (query) => {
    const prefix = "a".repeat(119);
    const snippet = snippetAroundMatch(`${prefix}😀z`, query);
    expect(snippet).toBe(prefix);
    expect(snippet).not.toMatch(/[\ud800-\udfff]/u);
  });

  it("keeps both boundaries whole without exceeding the snippet text budget", () => {
    const body = `😀${"a".repeat(39)}needle${"b".repeat(72)}`;
    const snippet = snippetAroundMatch(`xxxxx${body}😀z`, "needle");
    expect(snippet).toBe(`…${body}…`);
    expect(snippet.slice(1, -1).length).toBeLessThanOrEqual(120);
    expect(snippet).not.toMatch(/[\ud800-\udfff]/u);
  });

  it.each([
    { maxLen: 0, expected: "" },
    { maxLen: 1, expected: "" },
    { maxLen: 2, expected: "😀" },
  ])(
    "respects a $maxLen-unit fallback budget without splitting a character",
    ({ maxLen, expected }) => {
      const snippet = snippetAroundMatch("😀tail", "", maxLen);
      expect(snippet).toBe(expected);
      expect(snippet.length).toBeLessThanOrEqual(maxLen);
      expect(snippet).not.toMatch(/[\ud800-\udfff]/u);
    },
  );

  it("omits the leading ellipsis when the whole starting character reaches the text boundary", () => {
    const text = `😀${"a".repeat(39)}needle`;
    expect(snippetAroundMatch(text, "needle")).toBe(text);
  });

  it("retains a whole character that fits exactly at the matching snippet end", () => {
    const body = `needle${"a".repeat(112)}😀`;
    expect(snippetAroundMatch(`${body}tail`, "needle")).toBe(`${body}…`);
  });

  it("uses groupId for group search message jumps", () => {
    expect(searchHitThreadTarget({ groupId: "group-1" })).toEqual({ groupId: "group-1" });
    expect(searchHitThreadTarget({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
  });

  it("rejects ambiguous search hit targets", () => {
    expect(() => searchHitThreadTarget({})).toThrow();
    expect(() => searchHitThreadTarget({ botId: "bot-1", groupId: "group-1" })).toThrow();
  });
});

function link(url: string, messageId = "message-1"): SearchHit {
  return {
    kind: "link",
    botId: "bot-1",
    botName: "Scout",
    title: url,
    snippet: "match",
    messageId,
    seq: 4,
    url,
  };
}

function file(artifactId: string): SearchHit {
  return {
    kind: "file",
    botId: "bot-1",
    botName: "Scout",
    title: `${artifactId}.png`,
    snippet: "image/png, 10 bytes",
    messageId: "message-1",
    seq: 4,
    artifactId,
  };
}

describe("searchHitListKey", () => {
  it("keeps two links from the same message distinct", () => {
    const first = link("https://example.com/a");
    const second = link("https://example.com/b");
    expect(searchHitListKey(first)).not.toBe(searchHitListKey(second));
    expect(dedupeSearchHits([first, second, first])).toEqual([first, second]);
  });

  it("keeps two files sent in the same message distinct", () => {
    const first = file("artifact-1");
    const second = file("artifact-2");
    expect(searchHitListKey(first)).not.toBe(searchHitListKey(second));
    expect(dedupeSearchHits([first, second])).toEqual([first, second]);
  });

  it("drops a repeated hit", () => {
    const hit = link("https://example.com/a");
    expect(dedupeSearchHits([hit, { ...hit }])).toEqual([hit]);
  });
});
