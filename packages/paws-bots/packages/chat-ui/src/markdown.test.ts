import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  closeUnterminatedFence,
  inlineMarkdownImageSrc,
  linkFaviconOrigin,
  linkifyExplicitUrls,
  linkLabel,
  markdownLinkDisplayParts,
  markdownLinkNeedsPrompt,
  markdownLinkRequiresConfirmation,
  markdownLinkSite,
  markdownMentionId,
  plainTextLinkParts,
  sanitizeMarkdownImageUrl,
  sanitizeMarkdownUrl,
  withBlockMentions,
  withMentions,
} from "./markdown";

type Token = { type: string; attrGet(name: string): string | null; children: Token[] | null };
type Parser = Parameters<typeof linkifyExplicitUrls>[0] & {
  parseInline(source: string, env: object): Token[];
};

// The markdown-it the native renderer ships; chat-ui has no direct dependency on it.
const rendererRequire = createRequire(
  createRequire(import.meta.url).resolve("@ronradtke/react-native-markdown-display/package.json"),
);
const markdownIt = rendererRequire("markdown-it") as (options: { typographer: boolean }) => Parser;

function linkHrefs(text: string) {
  const parser = linkifyExplicitUrls(markdownIt({ typographer: true }));
  return (parser.parseInline(text, {})[0]?.children ?? [])
    .filter((token) => token.type === "link_open")
    .map((token) => token.attrGet("href"));
}

describe("linkifyExplicitUrls", () => {
  it("links bare http(s) URLs and email addresses", () => {
    expect(
      linkHrefs("see http://example.test and https://example.com/a?b=1, or bob@example.com"),
    ).toEqual(["http://example.test", "https://example.com/a?b=1", "mailto:bob@example.com"]);
  });

  it("leaves file names, bare domains and unopenable schemes as text", () => {
    expect(
      linkHrefs(
        "setup.py notes.md example.com www.example.com ftp://example.com //example.com javascript:alert(1)",
      ),
    ).toEqual([]);
  });
});

describe("plainTextLinkParts", () => {
  function visible(text: string) {
    return plainTextLinkParts(text)
      .map((part) => part.value)
      .join("");
  }

  it("links explicit urls and email addresses without interpreting markdown", () => {
    const text = "see http://example.test and https://example.com/a?b=1, or bob@example.com";
    expect(
      plainTextLinkParts(text).flatMap((part) => (part.type === "link" ? [part.href] : [])),
    ).toEqual(["http://example.test", "https://example.com/a?b=1", "mailto:bob@example.com"]);
    expect(visible("# Title **important**")).toBe("# Title **important**");
    expect(plainTextLinkParts("# Title **important**").every((part) => part.type === "text")).toBe(
      true,
    );
    expect(visible(text)).toBe(text);
  });

  it("leaves file names, bare domains, and unopenable schemes as text", () => {
    const text =
      "setup.py notes.md example.com www.example.com ftp://example.com //example.com javascript:alert(1)";
    expect(plainTextLinkParts(text).some((part) => part.type === "link")).toBe(false);
    expect(visible(text)).toBe(text);
  });

  it("keeps balanced parentheses inside a url and drops a prose closer", () => {
    const wiki = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(plainTextLinkParts(wiki)).toEqual([{ type: "link", value: wiki, href: wiki }]);

    const wrapped = "(see https://example.com)";
    expect(plainTextLinkParts(wrapped)).toEqual([
      { type: "text", value: "(see " },
      { type: "link", value: "https://example.com", href: "https://example.com" },
      { type: "text", value: ")" },
    ]);
    expect(visible(wiki)).toBe(wiki);
    expect(visible(wrapped)).toBe(wrapped);
  });

  it("matches bot autolinks when parentheses are nested or trailing", () => {
    const samples = [
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "(see https://example.com)",
      "https://example.com/foo_(bar))",
      "https://example.com/Foo_(bar_(baz))",
      "https://example.com/path_(a)_(b).",
    ];
    for (const text of samples) {
      expect(
        plainTextLinkParts(text).flatMap((part) => (part.type === "link" ? [part.href] : [])),
      ).toEqual(linkHrefs(text));
      expect(visible(text)).toBe(text);
    }
  });

  it("reads a page link a sent reply starts with, and keeps other markdown links literal", () => {
    expect(plainTextLinkParts("[Plan \\[v2\\]](page:pg_1)\nsee https://example.com")).toEqual([
      { type: "page", value: "Plan [v2]", pageId: "pg_1" },
      { type: "text", value: "\nsee " },
      { type: "link", value: "https://example.com", href: "https://example.com" },
    ]);
    const other = "[docs](https://example.com) [x](page:bad id)";
    expect(plainTextLinkParts(other).some((part) => part.type === "page")).toBe(false);
  });

  it("scans a long alphanumeric run without an at-sign quickly", () => {
    const text = "a".repeat(40_000);
    const started = performance.now();
    const parts = plainTextLinkParts(text);
    expect(performance.now() - started).toBeLessThan(250);
    expect(parts).toEqual([{ type: "text", value: text }]);
  });
});

describe("sanitizeMarkdownUrl", () => {
  it("allows normal external links and optionally allows local links", () => {
    expect(sanitizeMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(sanitizeMarkdownUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(sanitizeMarkdownUrl("/docs", true)).toBe("/docs");
    expect(sanitizeMarkdownUrl("#section", true)).toBe("#section");
  });

  it("rejects executable and embedded-data URLs", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("/docs")).toBeUndefined();
  });
});

describe("markdownLinkRequiresConfirmation", () => {
  const origin = "https://app.example.test";

  it("asks before an http(s) url on another origin", () => {
    expect(markdownLinkRequiresConfirmation("https://evil.example/a?b=1", origin)).toBe(true);
    expect(markdownLinkRequiresConfirmation("http://evil.example", origin)).toBe(true);
    expect(markdownLinkRequiresConfirmation(" HTTPS://evil.example/a ", origin)).toBe(true);
    expect(markdownLinkRequiresConfirmation("//evil.example/a", origin)).toBe(true);
    expect(markdownLinkRequiresConfirmation("https://files.app.example.test/a", origin)).toBe(true);
    expect(markdownLinkRequiresConfirmation("https://app.example.test:8443/a", origin)).toBe(true);
    expect(markdownLinkRequiresConfirmation("http://app.example.test/a", origin)).toBe(true);
  });

  it("opens same-origin and in-app routes without asking", () => {
    expect(markdownLinkRequiresConfirmation("https://app.example.test/threads/1", origin)).toBe(
      false,
    );
    expect(markdownLinkRequiresConfirmation("https://app.example.test:443/threads/1", origin)).toBe(
      false,
    );
    expect(markdownLinkRequiresConfirmation("https://USER:pw@app.example.test/a", origin)).toBe(
      false,
    );
    expect(markdownLinkRequiresConfirmation("/threads/1", origin)).toBe(false);
    expect(markdownLinkRequiresConfirmation("./notes.md", origin)).toBe(false);
    expect(markdownLinkRequiresConfirmation("../notes.md", origin)).toBe(false);
    expect(markdownLinkRequiresConfirmation("#section", origin)).toBe(false);
    expect(markdownLinkRequiresConfirmation("?tab=files", origin)).toBe(false);
  });

  it("opens mailto and tel without asking", () => {
    expect(markdownLinkRequiresConfirmation("mailto:hello@example.test", origin)).toBe(false);
    expect(markdownLinkRequiresConfirmation("mailto:hello@example.test?subject=Hi", origin)).toBe(
      false,
    );
    expect(markdownLinkRequiresConfirmation("tel:+15551212", origin)).toBe(false);
  });

  it("treats absolute http(s) urls as external when the app origin is unknown", () => {
    expect(markdownLinkRequiresConfirmation("https://evil.example/a", null)).toBe(true);
    expect(markdownLinkRequiresConfirmation("/threads/1", null)).toBe(false);
    expect(markdownLinkRequiresConfirmation("mailto:hello@example.test", null)).toBe(false);
  });

  it("does not ask for schemes the sanitizer will not open", () => {
    expect(markdownLinkRequiresConfirmation("javascript:alert(1)", origin)).toBe(false);
    expect(markdownLinkRequiresConfirmation("data:text/html,hi", origin)).toBe(false);
    expect(markdownLinkRequiresConfirmation("", origin)).toBe(false);
  });
});

describe("markdownLinkNeedsPrompt", () => {
  const origin = "https://app.example.test";

  it("opens a trusted site and its subdomains without asking", () => {
    const trusted = ["example.com"];
    expect(markdownLinkNeedsPrompt("https://example.com/a", origin, trusted)).toBe(false);
    expect(markdownLinkNeedsPrompt("https://docs.example.com/a?b=1", origin, trusted)).toBe(false);
    expect(markdownLinkNeedsPrompt("http://WWW.Example.com.", origin, trusted)).toBe(false);
  });

  it("still asks for any other site", () => {
    const trusted = ["example.com"];
    expect(markdownLinkNeedsPrompt("https://example.org/a", origin, trusted)).toBe(true);
    expect(markdownLinkNeedsPrompt("https://example.com.evil.test/a", origin, trusted)).toBe(true);
    expect(markdownLinkNeedsPrompt("https://example.com@evil.test/a", origin, trusted)).toBe(true);
    expect(markdownLinkNeedsPrompt("https://example.com/a", origin)).toBe(true);
  });

  it("keeps each tenant of a shared host its own site", () => {
    const trusted = ["alice.github.io"];
    expect(markdownLinkNeedsPrompt("https://alice.github.io/a", origin, trusted)).toBe(false);
    expect(markdownLinkNeedsPrompt("https://bob.github.io/a", origin, trusted)).toBe(true);
  });

  it("leaves links that never ask unchanged", () => {
    expect(markdownLinkNeedsPrompt("https://app.example.test/threads/1", origin, [])).toBe(false);
    expect(markdownLinkNeedsPrompt("mailto:hello@example.test", origin, [])).toBe(false);
    expect(markdownLinkNeedsPrompt("/threads/1", origin, [])).toBe(false);
  });
});

describe("markdownLinkSite", () => {
  it("names the registrable domain, or the tenant on a shared host", () => {
    expect(markdownLinkSite("https://docs.example.co.uk/a")).toBe("example.co.uk");
    expect(markdownLinkSite("https://alice.github.io/")).toBe("alice.github.io");
    expect(markdownLinkSite("http://192.0.2.1:8080/a")).toBe("192.0.2.1");
    expect(markdownLinkSite("mailto:hello@example.test")).toBeUndefined();
  });
});

describe("markdownLinkDisplayParts", () => {
  it("emphasizes the host, including a port, and leaves userinfo outside it", () => {
    expect(markdownLinkDisplayParts("https://evil.example:8443/a?b=1#c")).toEqual({
      before: "https://",
      host: "evil.example:8443",
      after: "/a?b=1#c",
    });
    expect(markdownLinkDisplayParts("https://user:secret@evil.example/a")).toEqual({
      before: "https://user:secret@",
      host: "evil.example",
      after: "/a",
    });
    expect(markdownLinkDisplayParts("https://[2001:db8::1]/a")).toEqual({
      before: "https://",
      host: "[2001:db8::1]",
      after: "/a",
    });
  });

  it("returns nothing for addresses that are not web links", () => {
    expect(markdownLinkDisplayParts("mailto:hello@example.test")).toBeUndefined();
    expect(markdownLinkDisplayParts("/threads/1")).toBeUndefined();
  });
});

describe("sanitizeMarkdownImageUrl", () => {
  it("allows absolute http(s) image sources", () => {
    expect(sanitizeMarkdownImageUrl(" https://example.test/a.png ")).toBe(
      "https://example.test/a.png",
    );
    expect(sanitizeMarkdownImageUrl("HTTP://example.test/a.png")).toBe("HTTP://example.test/a.png");
  });

  it("rejects schemes a browser link would open outside http(s)", () => {
    expect(sanitizeMarkdownImageUrl("mailto:user@example.test")).toBeUndefined();
    expect(sanitizeMarkdownImageUrl("tel:+15551212")).toBeUndefined();
    expect(sanitizeMarkdownImageUrl("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeMarkdownImageUrl("data:text/html,hi")).toBeUndefined();
    expect(sanitizeMarkdownImageUrl("/api/v1/p.gif")).toBeUndefined();
  });
});

describe("inlineMarkdownImageSrc", () => {
  it("keeps embedded raster image data", () => {
    expect(inlineMarkdownImageSrc(" data:image/png;base64,iVBORw0KGgo= ")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(inlineMarkdownImageSrc("data:image/jpeg;base64,/9j/4AAQ")).toBe(
      "data:image/jpeg;base64,/9j/4AAQ",
    );
  });

  it("rejects anything that would fetch, run, or exceed the size cap", () => {
    expect(inlineMarkdownImageSrc("https://attacker.example.test/p.gif?d=secret")).toBeUndefined();
    expect(inlineMarkdownImageSrc("/api/v1/p.gif")).toBeUndefined();
    expect(inlineMarkdownImageSrc("//attacker.example.test/p.gif")).toBeUndefined();
    expect(inlineMarkdownImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
    expect(inlineMarkdownImageSrc("data:text/html;base64,PHNjcmlwdD4=")).toBeUndefined();
    expect(
      inlineMarkdownImageSrc(`data:image/png;base64,${"A".repeat(1024 * 1024)}`),
    ).toBeUndefined();
  });
});

describe("closeUnterminatedFence", () => {
  it("temporarily closes a partial streaming code fence", () => {
    expect(closeUnterminatedFence("Before\n```ts\nconst value = 1;")).toBe(
      "Before\n```ts\nconst value = 1;\n```",
    );
  });

  it("leaves complete markdown unchanged", () => {
    const markdown = "```ts\nconst value = 1;\n```\n\nDone";
    expect(closeUnterminatedFence(markdown)).toBe(markdown);
  });

  it("closes a partial fence in CRLF text", () => {
    expect(closeUnterminatedFence("```ts\r\nconst value = 1;\r\n")).toBe(
      "```ts\r\nconst value = 1;\r\n\n```",
    );
  });

  it("recognises the closing fence in CRLF text", () => {
    const markdown = "```ts\r\nconst value = 1;\r\n```\r\n\r\nDone";
    expect(closeUnterminatedFence(markdown)).toBe(markdown);
  });

  it("keeps a CRLF fence open while the closing line carries text", () => {
    expect(closeUnterminatedFence("```ts\r\ncode\r\n``` not closing\r\n")).toBe(
      "```ts\r\ncode\r\n``` not closing\r\n\n```",
    );
  });

  it("does not add a second fence when a stream stops between \\r and \\n", () => {
    const closed = "```ts\r\ncode\r\n```\r";
    expect(closeUnterminatedFence(closed)).toBe(closed);
    expect(closeUnterminatedFence("```ts\r\ncode\r")).toBe("```ts\r\ncode\r\n```");
  });

  it("does not open a backtick fence whose info string has a backtick", () => {
    for (const markdown of ["```npm``` is great\nmore", "```a`b\ntext", "   ``` `x`\ntext"]) {
      expect(closeUnterminatedFence(markdown)).toBe(markdown);
    }
  });

  it("still opens a tilde fence whose info string has a backtick", () => {
    expect(closeUnterminatedFence("~~~ a`b\ncode")).toBe("~~~ a`b\ncode\n~~~");
  });
});

describe("link labels", () => {
  it.each([
    ["https://x.com/elonmusk/status/123?s=20", "x.com/elonmusk/status/123"],
    ["https://www.example.com/", "example.com"],
    ["http://example.com", "example.com"],
    ["www.example.com/docs/", "example.com/docs"],
    ["https://example.com/caf%C3%A9#menu", "example.com/café"],
    ["https://example.com:8080/a", "example.com:8080/a"],
    [
      "https://github.com/example-org/example-repository/pull/12345/files",
      "github.com/example-org/example-reposito…",
    ],
    ["http://example.com/?q=1", "example.com"],
  ])("shortens the bare URL %s to %s", (text, label) => {
    const href = text.startsWith("www.") ? `http://${text}` : text;
    expect(linkLabel(text, href)).toBe(label);
  });

  it("treats a label that differs only in scheme or a trailing slash as bare", () => {
    expect(linkLabel("http://example.com/docs", "https://example.com/docs/")).toBe(
      "example.com/docs",
    );
  });

  it("treats a label showing the address with its escapes decoded as bare", () => {
    expect(linkLabel("https://example.com/café", "https://example.com/caf%C3%A9")).toBe(
      "example.com/café",
    );
    expect(
      linkLabel("https://example.com/\u202Etxt.exe", "https://example.com/%E2%80%AEtxt.exe"),
    ).toBe("example.com/txt.exe");
  });

  it("does not split a surrogate pair at the path truncation boundary", () => {
    const prefix = "a".repeat(26);
    const href = `https://example.com/${prefix}\u{1F600}tail`;
    expect(linkLabel(href, href)).toBe(`example.com/${prefix}…`);

    const fits = `https://example.com/${"a".repeat(25)}\u{1F600}tail`;
    expect(linkLabel(fits, fits)).toBe(`example.com/${"a".repeat(25)}\u{1F600}…`);
    const short = "https://example.com/\u{1F600}";
    expect(linkLabel(short, short)).toBe("example.com/\u{1F600}");
  });

  it("never cuts the host, however long, and trims only the path", () => {
    const host = "www.paypal.com.account-verify-login-secure-update.example.com";
    expect(linkLabel(`https://${host}/x`, `https://${host}/x`)).toBe(
      "paypal.com.account-verify-login-secure-update.example.com/x",
    );
    expect(
      linkLabel(
        `https://${host}/a/very/long/path/that/goes/on`,
        `https://${host}/a/very/long/path/that/goes/on`,
      ),
    ).toBe("paypal.com.account-verify-login-secure-update.example.com/a/very/lon…");
  });

  it("drops bidi overrides, zero-width and control characters from the path", () => {
    const href = "https://example.com/%E2%80%AEgnp.exe%E2%80%8B%E2%81%A0%EF%BB%BF%E2%81%A6x%0A";
    expect(linkLabel(href, href)).toBe("example.com/gnp.exex");
  });

  it("keeps an international host in its ASCII form", () => {
    const href = "https://аpple.com/login";
    expect(linkLabel(href, href)).toBe("xn--pple-43d.com/login");
  });

  it("keeps an author's label as written, even when it names another address", () => {
    expect(linkLabel("Post", "https://x.com/a/status/1")).toBe("Post");
    expect(linkLabel("https://other.example", "https://x.com/")).toBe("https://other.example");
  });

  it("keeps labels of links that are not websites", () => {
    expect(linkLabel("mailto:me@example.com", "mailto:me@example.com")).toBe(
      "mailto:me@example.com",
    );
    expect(linkLabel("/docs", "/docs")).toBe("/docs");
  });

  it("gives only http(s) links an icon origin", () => {
    expect(linkFaviconOrigin("https://www.example.com/a?b#c")).toBe("https://www.example.com");
    expect(linkFaviconOrigin("http://example.com:8080/a")).toBe("http://example.com:8080");
    for (const href of ["mailto:a@example.com", "tel:+15555550100", "/docs", "#top", ""]) {
      expect(linkFaviconOrigin(href)).toBeUndefined();
    }
  });
});

it("highlights the destination host after userinfo containing the same host text", () => {
  expect(markdownLinkDisplayParts("https://docs.example.test@docs.example/a")).toEqual({
    before: "https://docs.example.test@",
    host: "docs.example",
    after: "/a",
  });
  expect(markdownLinkDisplayParts("https://docs.example:docs.example@docs.example/a")).toEqual({
    before: "https://docs.example:docs.example@",
    host: "docs.example",
    after: "/a",
  });
});

describe("withMentions", () => {
  const planner = { id: "bot-1", name: "Planner" };
  const link = "[Planner](rakazo-mention:bot-1)";

  it("links the first appearance of the name across the message", () => {
    expect(
      withMentions(["Working.", "Planner is ready. Ask Planner.", "Planner again."], [planner]),
    ).toEqual(["Working.", `${link} is ready. Ask Planner.`, "Planner again."]);
  });

  it("puts the mention once at the start when the message does not name it", () => {
    expect(withMentions(["Ready when you are.", "Done."], [planner])).toEqual([
      `${link} Ready when you are.`,
      "Done.",
    ]);
    expect(withMentions(["- first step"], [planner])).toEqual([`${link}\n\n- first step`]);
  });

  it("leaves code, links, and longer words alone", () => {
    const text =
      "`Planner` [Planner](https://example.test) Planners\n\n```\nPlanner\n```\n\n    Planner\n\nPlanner is ready.";
    expect(withMentions([text], [planner])).toEqual([
      text.replace("Planner is ready.", `${link} is ready.`),
    ]);
  });

  it.each([
    "``Planner `literal` example``",
    "`Planner\nexample`",
    "````md\n```\nPlanner\n```\n````",
    "~~~~md\n~~~\nPlanner\n~~~\n~~~~",
    "> ```\n> Planner\n> ```",
  ])("preserves code source and links later prose: %s", (code) => {
    expect(withMentions([`${code}\n\nPlanner is ready.`], [planner])).toEqual([
      `${code}\n\n${link} is ready.`,
    ]);
  });

  it("keeps an unclosed streaming fence intact and prepends the mention", () => {
    const code = "```md\nPlanner\n\nPlanner is ready.";
    expect(withMentions([code], [planner])).toEqual([`${link}\n\n${code}`]);
  });

  it.each([
    "``[Planner](rakazo-mention:bot-1) `literal` ``",
    "`[Planner](rakazo-mention:bot-1)\nexample`",
    "````md\n```\n[Planner](rakazo-mention:bot-1)\n```\n````",
    "~~~~md\n~~~\n[Planner](rakazo-mention:bot-1)\n~~~\n~~~~",
  ])("does not strip model mention links inside code: %s", (code) => {
    expect(withMentions([`${code}\n\nPlanner is ready.`], [planner])).toEqual([
      `${code}\n\n${link} is ready.`,
    ]);
  });

  it("preserves literal mention syntax in an ordinary link's code label", () => {
    const text = "[`[Planner](rakazo-mention:bot-1)`](https://example.com)";
    expect(withMentions([text], [planner])).toEqual([`${link} ${text}`]);
  });

  it("strips a model mention wrapper while preserving inline code in its label", () => {
    expect(withMentions(["[Use `Planner`](rakazo-mention:bot-1) is ready."], [planner])).toEqual([
      `${link} Use \`Planner\` is ready.`,
    ]);
  });

  it("continues processing valid blocks after a malformed block", () => {
    const nested = `${"> ".repeat(10000)}Planner`;
    expect(withMentions([nested, "Planner is ready."], [planner])).toEqual([
      nested,
      `${link} is ready.`,
    ]);
  });

  it("preserves deeply nested Markdown when preprocessing cannot parse it", () => {
    const text = `${"> ".repeat(10000)}Planner`;
    expect(withMentions([text], [planner])).toEqual([text]);
  });

  it("keeps a mention link already in the text as its name", () => {
    expect(withMentions(["[Planner](rakazo-mention:bot-1) is ready."], [planner])).toEqual([
      `${link} is ready.`,
    ]);
    const code = "`[Planner](rakazo-mention:bot-1)`\n\n```\n[Planner](rakazo-mention:bot-1)\n```";
    expect(withMentions([code], [planner])).toEqual([`${link} ${code}`]);
  });

  it("escapes markdown in the name and encodes the id", () => {
    expect(withMentions(["hi"], [{ id: "a/b", name: "[x]_y" }])).toEqual([
      "[\\[x\\]\\_y](rakazo-mention:a%2Fb) hi",
    ]);
    expect(markdownMentionId("rakazo-mention:a%2Fb")).toBe("a/b");
    expect(markdownMentionId("https://example.test")).toBeUndefined();
  });

  it("rewrites only prose blocks", () => {
    const blocks = withBlockMentions(
      [
        { kind: "progress", text: "Planner tool", activity: true },
        { kind: "text", text: "Planner is ready." },
      ],
      [planner],
    );
    expect(blocks).toEqual([
      { kind: "progress", text: "Planner tool", activity: true },
      { kind: "text", text: `${link} is ready.` },
    ]);
  });
});
