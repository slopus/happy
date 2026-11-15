import { describe, expect, it, vi } from "vitest";
import { plainTextFromMarkdown, truncatedPlainText } from "./markdown-plain.js";

describe("plainTextFromMarkdown", () => {
  it("reads only a bounded preview of the source unless the caller raises the limit", () => {
    const long = `${"word ".repeat(2_000)}the end`;
    expect(plainTextFromMarkdown(long)).not.toContain("the end");
    expect(plainTextFromMarkdown(long, { maxSource: 20_000 })).toContain("the end");
  });

  it("does not rebuild the placeholder pattern for each escaped character", () => {
    const markerText = "\uE000".repeat(128);
    const source = `${markerText}${"\\*".repeat(128)} <_ops_@example.test>`;
    let compiledPatterns = 0;
    vi.stubGlobal(
      "RegExp",
      new Proxy(RegExp, {
        construct(target, args) {
          compiledPatterns += 1;
          return Reflect.construct(target, args);
        },
      }),
    );
    try {
      expect(plainTextFromMarkdown(source)).toBe(
        `${markerText}${"*".repeat(128)} _ops_@example.test`,
      );
      expect(compiledPatterns).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    "Saved monthly_sales_report.csv",
    "Set DATABASE_POOL_SIZE to 12",
    "Keep foo__bar__baz unchanged",
    "Open https://example.test/monthly_sales_report",
    "Email first_middle_last@example.test",
    "保留客户_月度_报告和équipe_nom_complet",
    "Keep cafe\u0301_nom_ unchanged",
  ])("preserves underscores inside words: %s", (text) => {
    expect(plainTextFromMarkdown(text)).toBe(text);
  });

  it("still removes underscore emphasis around identifiers and punctuation", () => {
    expect(
      plainTextFromMarkdown("_one_ __two__ ___three___ (_four_) __monthly_sales_report__"),
    ).toBe("one two three (four) monthly_sales_report");
  });

  it("removes nested underscore emphasis without changing identifiers", () => {
    expect(plainTextFromMarkdown("__bold _italic_ bold__")).toBe("bold italic bold");
    expect(plainTextFromMarkdown("__bold _italic___")).toBe("bold italic");
    expect(plainTextFromMarkdown("___bold__ italic_")).toBe("bold italic");
    expect(plainTextFromMarkdown("_italic __bold__ italic_ and __monthly_sales_report__")).toBe(
      "italic bold italic and monthly_sales_report",
    );
  });

  it("preserves a long sequence of unmatched underscore openers", () => {
    const text = "_word ".repeat(600).trim();
    expect(plainTextFromMarkdown(text)).toBe(text);
  });

  it.each(["_one_~~two~~", "~~one~~_two_", "_one_**two**", "**one**_two_"])(
    "removes adjacent formatting without changing delimiter boundaries: %s",
    (text) => expect(plainTextFromMarkdown(text)).toBe("onetwo"),
  );

  it("does not let HTML attribute underscores steal visible emphasis", () => {
    expect(plainTextFromMarkdown('_Open <a href="/_draft">report</a> now_')).toBe(
      "Open report now",
    );
    expect(plainTextFromMarkdown('_Open <a title=">_draft">report</a> now_')).toBe(
      "Open report now",
    );
    expect(plainTextFromMarkdown('<a title="> report')).toBe("report");
    expect(plainTextFromMarkdown('_See <a title="> now_')).toBe("See now");
    expect(plainTextFromMarkdown('See <a href="x>y" title="z')).toBe("See");
  });

  it("drops emphasis markers", () => {
    expect(plainTextFromMarkdown("Created **Projects-CoS** as a **Project**")).toBe(
      "Created Projects-CoS as a Project",
    );
  });

  it("keeps link labels and heading or list words", () => {
    expect(plainTextFromMarkdown("# Status\n- see [the report](https://example.com)")).toBe(
      "Status see the report",
    );
  });

  it("keeps the label of a link whose destination contains parentheses", () => {
    expect(plainTextFromMarkdown("See [docs](https://example.com/a_(b)) next")).toBe(
      "See docs next",
    );
    expect(plainTextFromMarkdown("![plot](https://example.com/a_(b_(c)))")).toBe("plot");
  });

  it("keeps a link label with nested brackets", () => {
    expect(plainTextFromMarkdown("See [the [inner] docs](https://example.com)")).toBe(
      "See the [inner] docs",
    );
    expect(plainTextFromMarkdown("see ![a [b] icon](img.png) here")).toBe("see a [b] icon here");
  });

  it("keeps CommonMark autolink text", () => {
    expect(plainTextFromMarkdown("<https://example.com>")).toBe("https://example.com");
    expect(plainTextFromMarkdown("Open <https://example.com/a_(b)> now")).toBe(
      "Open https://example.com/a_(b) now",
    );
    expect(plainTextFromMarkdown("<user@example.com>")).toBe("user@example.com");
  });

  it.each([
    ["<https://example.test/_draft_>", "https://example.test/_draft_"],
    ["<_ops_@example.test>", "_ops_@example.test"],
    ["<https://example.test/*draft*/~~old~~>", "https://example.test/*draft*/~~old~~"],
    ["**Contact** <_ops_@example.test> _today_", "Contact _ops_@example.test today"],
    ["_<https://example.test/_draft_>_", "https://example.test/_draft_"],
    ["<https://example.test/\\_draft\\_>", "https://example.test/_draft_"],
    ["`<https://example.test/_draft_>`", "<https://example.test/_draft_>"],
  ])("keeps autolink destinations literal: %s", (source, expected) => {
    expect(plainTextFromMarkdown(source)).toBe(expected);
  });

  it("keeps inline code contents", () => {
    expect(plainTextFromMarkdown("Use `pnpm test` first")).toBe("Use pnpm test first");
  });

  it("does not strip Markdown that lives inside code", () => {
    expect(plainTextFromMarkdown("Use `<tag>` here")).toBe("Use <tag> here");
    expect(plainTextFromMarkdown("Keep `*x*` and `[label](url)`")).toBe(
      "Keep *x* and [label](url)",
    );
    expect(plainTextFromMarkdown("```\nuse <https://example.com> and *y*\n```")).toBe(
      "use <https://example.com> and *y*",
    );
  });

  it("collapses a fenced block and surrounding prose to one line", () => {
    expect(plainTextFromMarkdown("Done.\n\n```ts\nconst x = 1;\n```\n\nShipped.")).toBe(
      "Done. const x = 1; Shipped.",
    );
  });

  it("closes a fence only on a matching run of the opener", () => {
    expect(plainTextFromMarkdown("````\n```\nstill in the fence\n````")).toBe(
      "``` still in the fence",
    );
    expect(plainTextFromMarkdown("```\na ``` b\n```")).toBe("a ``` b");
    expect(plainTextFromMarkdown("~~~~\ncode with ~~~\nstill\n~~~~")).toBe("code with ~~~ still");
  });

  it("keeps a short unclosed fence literal", () => {
    expect(plainTextFromMarkdown("```\n*bold*")).toBe("``` bold");
    // Not truncated, so the opener stays text and emphasis after it still strips.
    expect(plainTextFromMarkdown("```x\nstill **bold**")).toBe("```x still bold");
  });

  it("still closes a fence that ends inside a long reply", () => {
    const source = "```\nkeep *stars*\n```\n**after** " + "z".repeat(6_000);
    const preview = plainTextFromMarkdown(source);
    expect(preview.startsWith("keep *stars* after")).toBe(true);
    expect(preview).not.toContain("```");
    expect(preview).not.toContain("**");
  });

  it("preserves a code block when the preview cap cuts off its closing fence", () => {
    const source =
      "```ts\nkeep *stars* and <tag> and | a | b |\n" + "y".repeat(6_000) + "\n```\nAFTER";
    const preview = plainTextFromMarkdown(source);
    expect(preview.startsWith("keep *stars* and <tag> and | a | b |")).toBe(true);
    expect(preview).not.toContain("```");
    expect(preview).not.toContain("AFTER");
    expect(preview).toContain("<tag>");
    expect(preview).toContain("| a | b |");
  });

  it("does not spend the preview cap on leading whitespace", () => {
    expect(plainTextFromMarkdown(`${" \n".repeat(8_000)}**hello**`)).toBe("hello");
    expect(plainTextFromMarkdown(`${" ".repeat(8_000)}\`*x*\``)).toBe("*x*");
  });

  it("bounds work on a long run of unclosed fences", () => {
    const source = `${"```x\n".repeat(20_000)}TAIL_MARKER`;
    const started = Date.now();
    const preview = plainTextFromMarkdown(source);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(preview).not.toContain("TAIL_MARKER");
    expect(preview.length).toBeLessThan(4_096);
    expect(preview.startsWith("```x")).toBe(true);
  });

  it("still finds a later link after many unmatched brackets", () => {
    const noise = "[".repeat(2_000);
    expect(plainTextFromMarkdown(`${noise} see [docs](https://example.com/a_(b))`)).toBe(
      `${noise} see docs`,
    );
  });

  it("does not treat existing private-use characters as code placeholders", () => {
    expect(plainTextFromMarkdown("\uE0000\uE000 keep `*x*`")).toBe("\uE0000\uE000 keep *x*");
    const noise = "\uE000".repeat(2_000);
    expect(plainTextFromMarkdown(`${noise} keep \`*x*\``)).toBe(`${noise} keep *x*`);
  });

  it("keeps backslash-escaped punctuation as literal text", () => {
    expect(plainTextFromMarkdown("Use \\*literal\\*")).toBe("Use *literal*");
  });

  it("keeps escaped punctuation literal inside code spans", () => {
    expect(plainTextFromMarkdown("Run `\\*x\\*` verbatim")).toBe("Run \\*x\\* verbatim");
    expect(plainTextFromMarkdown("| `a\\|b` | `\\*c` |\n| --- | --- |\n| 1 | 2 |")).toBe(
      "a\\|b, \\*c 1, 2",
    );
  });

  it("does not let a round-tripped autolink impersonate a payload token", () => {
    // The URL restores literal mark characters; without re-tokenizing them the
    // stashed payload would contain E02E0 — a reference to itself — and
    // restoring it would recurse forever.
    expect(plainTextFromMarkdown("\\* <https://x/2>")).toBe("* https://x/2");
  });

  it("protects escapes well past the old payload cap", () => {
    const noise = "\\*".repeat(300);
    expect(plainTextFromMarkdown(`${noise}\n| a\\|b | c |`)).toBe(`${"*".repeat(300)} a|b, c`);
  });

  it("flattens table rows and drops separator rows", () => {
    expect(plainTextFromMarkdown("| Name | Value |\n| --- | ---: |\n| Alice | 5 |")).toBe(
      "Name, Value Alice, 5",
    );
  });

  it("drops a bare separator row", () => {
    expect(plainTextFromMarkdown("Totals\n\n| --- | --- |\n\nDone")).toBe("Totals Done");
  });

  it("flattens cell contents before stripping their formatting", () => {
    expect(plainTextFromMarkdown("| **bold** | `x|y` | [docs](https://example.test) |")).toBe(
      "bold, x|y, docs",
    );
  });

  it("flattens tables that omit outer pipes", () => {
    expect(plainTextFromMarkdown("Name | Value\n--- | ---\nAlice | 5")).toBe(
      "Name, Value Alice, 5",
    );
  });

  it("keeps dash-only cells once the table has begun", () => {
    expect(plainTextFromMarkdown("| a | b |\n| --- | --- |\n| - | - |\n| 1 | 2 |")).toBe(
      "a, b -, - 1, 2",
    );
  });

  it("does not treat a colon-only row as a delimiter", () => {
    // `| : |` lacks the hyphen every GFM delimiter cell needs — it is content.
    expect(plainTextFromMarkdown("a | b\n| : |")).toBe("a | b :");
  });

  it("ends the table at quote, list, and break lines instead of absorbing them", () => {
    expect(plainTextFromMarkdown("| a |\n| - |\n> keep a | b")).toBe("a keep a | b");
    expect(plainTextFromMarkdown("| a |\n| - |\n- x | y")).toBe("a x | y");
    expect(plainTextFromMarkdown("| a |\n| - |\n---\nb | c")).toBe("a b | c");
  });

  it("still flattens a quoted stand-alone table row", () => {
    expect(plainTextFromMarkdown("> | q | r |")).toBe("q, r");
  });

  it("treats a marked separator row as syntax, not cells", () => {
    expect(plainTextFromMarkdown("> | --- |")).toBe("");
    expect(plainTextFromMarkdown("- | --- |")).toBe("");
    expect(plainTextFromMarkdown("| a | b |\n| --- | --- |\n> | --- | --- |\n| c | d |")).toBe(
      "a, b c, d",
    );
  });

  it("keeps separator-shaped lines inside fenced code", () => {
    expect(plainTextFromMarkdown("```\n|---|\n```")).toBe("|---|");
    expect(plainTextFromMarkdown("| a |\n| - |\n```\nx | y\n```")).toBe("a x | y");
  });

  it("splits rows on real pipes around escapes and unmatched backticks", () => {
    expect(plainTextFromMarkdown("| a\\|b | c |\n| - | - |")).toBe("a|b, c");
    expect(plainTextFromMarkdown("| `a | b |")).toBe("`a, b");
  });

  it("keeps escaped asterisks literal inside table cells", () => {
    // Android parity: \* must survive as "*" past the emphasis strips.
    expect(plainTextFromMarkdown("| \\*x\\* | y |\n| - | - |")).toBe("*x*, y");
  });

  it("strips ordered list markers in both styles", () => {
    // Android parity: `1)` is a list marker like `1.` — a shared fix.
    expect(plainTextFromMarkdown("1. first\n2) second")).toBe("first second");
    expect(plainTextFromMarkdown("  3) third")).toBe("third");
    // No space after the marker keeps the digits as text.
    expect(plainTextFromMarkdown("1)st place")).toBe("1)st place");
  });

  it("strips quote markers without a space and indented headings", () => {
    // Android parity: `>x` is a quote and `  ## h` is a heading there.
    expect(plainTextFromMarkdown(">hello")).toBe("hello");
    expect(plainTextFromMarkdown("   ## Title")).toBe("Title");
    expect(plainTextFromMarkdown("| a |\n| - |\n>b | c")).toBe("a b | c");
  });

  it("leaves mid-sentence pipes alone", () => {
    expect(plainTextFromMarkdown("either a | b or c")).toBe("either a | b or c");
    expect(plainTextFromMarkdown("a | b")).toBe("a | b");
  });

  it("returns empty when only markers remain", () => {
    expect(plainTextFromMarkdown("")).toBe("");
    expect(plainTextFromMarkdown("   **  **   ")).toBe("");
  });
});

describe("truncatedPlainText", () => {
  it("strips markers before cutting the preview", () => {
    expect(truncatedPlainText("Created **Projects-CoS** as a **Project**", 28)).toBe(
      "Created Projects-CoS as a Pr",
    );
    expect(truncatedPlainText("Created **Projects-CoS** as a **Project**", 28)).not.toContain("*");
  });

  it("does not split a supplementary character at the cut", () => {
    const preview = truncatedPlainText(`${"a".repeat(179)}\u{1F600}b`, 180);
    expect(preview).toBe("a".repeat(179));
    expect(preview).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

describe("plainTextFromMarkdown comparison signs", () => {
  it("keeps a less-than before a dollar amount", () => {
    expect(plainTextFromMarkdown("Costs < $5, so it's cheap")).toBe("Costs < $5, so it's cheap");
  });

  it("keeps a less-than between variables", () => {
    expect(plainTextFromMarkdown("Is a < b? Yes, it's true.")).toBe("Is a < b? Yes, it's true.");
  });

  it("keeps spaced comparisons on both sides", () => {
    expect(plainTextFromMarkdown("If 1 < 2 and 3 > 2 then ok")).toBe("If 1 < 2 and 3 > 2 then ok");
  });

  it("keeps less-or-equal and greater-or-equal", () => {
    expect(plainTextFromMarkdown("keep <= 10 and >= 2")).toBe("keep <= 10 and >= 2");
  });

  it("keeps a less-than followed directly by a digit", () => {
    expect(plainTextFromMarkdown("1 <2 and 3> 4")).toBe("1 <2 and 3> 4");
  });

  it("keeps unspaced comparisons that look like tags", () => {
    expect(plainTextFromMarkdown("Check a<b+1 and c>d")).toBe("Check a<b+1 and c>d");
    expect(plainTextFromMarkdown("x<y && z>0")).toBe("x<y && z>0");
  });

  it("still strips real tags", () => {
    expect(plainTextFromMarkdown("Use <b>bold</b> now")).toBe("Use bold now");
  });

  it("still strips comments", () => {
    expect(plainTextFromMarkdown("a <!-- note --> b")).toBe("a b");
  });
});

describe("plainTextFromMarkdown HTML comments", () => {
  it.each([
    "a <!-- x > hidden --> b",
    "a <!-- x > hidden\nmore --> b",
    "a <!-- an unmatched ' quote > hidden --> b",
    "a <!-- <b>hidden</b> --> b",
    "a <!-- x > hidden --> <!-- more > hidden --> b",
  ])("removes the complete comment in %s", (source) => {
    expect(plainTextFromMarkdown(source)).toBe("a b");
  });

  it.each(["a <!-- hidden", "a <!-- x > hidden"])("hides an unfinished comment in %s", (source) => {
    expect(plainTextFromMarkdown(source)).toBe("a");
  });

  it("keeps comments written as literal code or escaped text", () => {
    expect(plainTextFromMarkdown("`<!-- x > hidden -->`")).toBe("<!-- x > hidden -->");
    expect(plainTextFromMarkdown("\\<!-- x > hidden -->")).toBe("<!-- x > hidden -->");
  });
});
