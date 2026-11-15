import type { MessageBlock } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveMessageQuote,
  messageReplyExcerpt,
  messageReplyPreview,
  visibleTextFromMarkdown,
} from "./message-quote.js";

const textBlock = (text: string): MessageBlock[] => [{ kind: "text", text }];

describe("visibleTextFromMarkdown", () => {
  it("uses rendered GFM text rather than Markdown source syntax", () => {
    expect(
      visibleTextFromMarkdown(
        "## Status\n\n1. Review **the diff**\n2. Read [docs](https://example.test/a_(b))",
      ),
    ).toBe("Status\nReview the diff\nRead docs");
  });

  it("keeps literal code content but drops fence metadata", () => {
    expect(visibleTextFromMarkdown("```text\nalpha\n---\nomega\n```")).toBe("alpha\n---\nomega\n");
  });
});

describe("deriveMessageQuote", () => {
  it.each([
    ["formatted text", "we saw **42%** growth", "42% growth", "42% growth"],
    [
      "ordered lists",
      "1. Review the diff\n2. Run the tests",
      "Review the diff\nRun the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "parenthesized lists",
      "1) Review the diff\n2) Run the tests",
      "Review the diff Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "blockquoted lists",
      "> 1. Review the diff\n> 2. Run the tests",
      "Review the diff Run the tests",
      "Review the diff\nRun the tests",
    ],
    ["tables", "| Name | Value |\n| --- | ---: |\n| Alice | 5 |", "Alice 5", "Alice 5"],
    ["inline code", "Run `pnpm test` now", "pnpm test", "pnpm test"],
    ["fenced code", "```text\n2. restart()\n```", "2. restart()", "2. restart()"],
    ["indented code", "    2. restart()", "2. restart()", "2. restart()"],
    ["escaped punctuation", String.raw`C\+\+ is useful`, "C++ is useful", "C++ is useful"],
    [
      "nested link destinations",
      "See [docs](https://example.test/a_(b)) next",
      "docs next",
      "docs next",
    ],
    [
      "reference links",
      "Read [the guide][g] next\n\n[g]: https://example.test",
      "the guide next",
      "the guide next",
    ],
    [
      "autolinks",
      "Open <https://example.test/a_(b)> now",
      "https://example.test/a_(b)",
      "https://example.test/a_(b)",
    ],
    ["entities", "Copyright &copy; and &#x1F600;", "Copyright © and 😀", "Copyright © and 😀"],
  ])("derives quotes from rendered %s", (_name, markdown, hint, expected) => {
    expect(deriveMessageQuote(textBlock(markdown), hint, "markdown")).toBe(expected);
  });

  it.each([
    ["C++ is fast", "C is fast"],
    ["key:value pairs", "key value pairs"],
    ["version 1.2", "version 12"],
    ["```text\nalpha\n---\nomega\n```", "alpha omega"],
    ["```text\nbody\n```", "text"],
    ["Read [docs](https://example.test/private)", "https://example.test/private"],
    ["Alice", "alice"],
  ])("rejects text that is not visibly present in %s", (markdown, hint) => {
    expect(deriveMessageQuote(textBlock(markdown), hint, "markdown")).toBeUndefined();
  });

  it("persists the canonical server slice rather than client whitespace", () => {
    expect(
      deriveMessageQuote(
        textBlock("1. Review the diff\n2. Run the tests"),
        "Review the diff Run the tests",
        "markdown",
      ),
    ).toBe("Review the diff\nRun the tests");
  });

  it("keeps markup literal for plain-text message roles", () => {
    expect(
      deriveMessageQuote(
        textBlock("Use **literal emphasis** and `literal code`"),
        "**literal emphasis** and `literal code`",
        "plain-text",
      ),
    ).toBe("**literal emphasis** and `literal code`");
  });

  it("does not derive quotes from structured message blocks", () => {
    const blocks: MessageBlock[] = [{ kind: "card", lines: [{ k: "Secret", v: "value" }] }];
    expect(deriveMessageQuote(blocks, "Secret value", "markdown")).toBeUndefined();
  });

  it("does not join text across separate rendered regions", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "alpha" },
      { kind: "card", lines: [{ k: "Status", v: "between" }] },
      { kind: "text", text: "beta" },
    ];
    expect(deriveMessageQuote(blocks, "alpha beta", "markdown")).toBeUndefined();
  });

  it("declines oversized parent text before parsing it", () => {
    expect(
      deriveMessageQuote(textBlock(`needle${"x".repeat(100_000)}`), "needle", "markdown"),
    ).toBeUndefined();
  });

  it("sees the same table-cell text the web renderer shows", () => {
    // ChatMarkdown salvages <br> and <img alt> text inside cells; a selection of
    // that rendered text must still match the canonical excerpt.
    const blocks = textBlock("| A | B |\n| --- | --- |\n| one<br>two | <img src=x alt='chart'> |");
    expect(deriveMessageQuote(blocks, "one two", "markdown")).toBe("one two");
    expect(deriveMessageQuote(blocks, "chart", "markdown")).toBe("chart");
  });

  it.each([
    '<img alt="Chart" data-alt="Decorative">',
    '<img title="1 > 0" alt="Chart">',
    '<img alt="Chart" title="alt=Decorative">',
  ])("derives table quotes from the real image description: %s", (html) => {
    const blocks = textBlock(`| Description |\n| --- |\n| ${html} |`);
    expect(deriveMessageQuote(blocks, "Chart", "markdown")).toBe("Chart");
    expect(deriveMessageQuote(blocks, "Decorative", "markdown")).toBeUndefined();
  });

  it("truncates a whitespace-heavy excerpt to the cap instead of dropping it", () => {
    // 1000 single-char tokens survive the normalized hint, but their source
    // slice keeps the blank lines and cleans to more than the cap.
    const parent = Array.from({ length: 1200 }, () => "a").join("\n\n\n");
    const hint = Array.from({ length: 1200 }, () => "a").join(" ");
    const quote = deriveMessageQuote(textBlock(parent), hint, "markdown");
    expect(quote).toBeDefined();
    expect(quote?.length).toBe(REPLY_QUOTE_MAX_LENGTH);
  });

  it("does not split a surrogate pair when the hint hits the cap", () => {
    const parent = "a".repeat(REPLY_QUOTE_MAX_LENGTH - 1);
    const quote = deriveMessageQuote(textBlock(parent), `${parent}😀`, "markdown");
    expect(quote).toBe(parent);
  });
});

describe("messageReplyExcerpt", () => {
  it("uses the first visible line and strips bot Markdown", () => {
    expect(messageReplyExcerpt(textBlock("\n## **First** line\n\nSecond line"), "bot")).toBe(
      "First line",
    );
    expect(messageReplyExcerpt(textBlock("**literal**\nSecond line"), "user")).toBe("**literal**");
  });
  it("bounds the preview and handles messages without text", () => {
    expect(messageReplyExcerpt(textBlock("a".repeat(1000)), "bot")).toHaveLength(280);
    expect(messageReplyExcerpt([], "user")).toBe("");
    expect(
      messageReplyExcerpt(
        [{ kind: "image", artifactId: "image", mimeType: "image/png", name: "example.png" }],
        "user",
      ),
    ).toBe("example.png");
  });
});

const visibleBlocks: Array<[MessageBlock, string]> = [
  [{ kind: "ask", text: "Which release?" }, "Which release?"],
  [
    {
      kind: "channel_message",
      provider: "test",
      channelId: "channel",
      fromAddress: "sender",
      fromLabel: "Sender",
      text: "Release notes",
    },
    "Release notes",
  ],
  [{ kind: "chart", name: "Adoption", spec: {}, data: [] }, "Adoption"],
  [{ kind: "choice", question: "Choose a version", options: [] }, "Choose a version"],
  [{ kind: "card", lines: [{ k: "Version", v: "One" }] }, "Version: One"],
  [{ kind: "connect", name: "Mail", initial: "M", color: "test", status: "pending" }, "Mail"],
  [
    {
      kind: "app_connect",
      name: "Mail",
      provider: "test",
      description: "Connect",
      logo: null,
      status: "pending",
    },
    "Mail",
  ],
  [{ kind: "computer", state: "ready", text: "Ready" }, "Ready"],
  [{ kind: "voice_call", title: "Voice call", farewell: "Bye" }, "Voice call"],
  [{ kind: "meta", text: "Paused" }, "Paused"],
  [{ kind: "progress", text: "Working" }, "Working"],
  [{ kind: "steps", steps: [{ label: "Search", count: 1 }] }, "Search"],
  [
    { kind: "subagent", agentId: "agent", name: "Research", task: "Search", status: "running" },
    "Research",
  ],
  [{ kind: "child_bot", botId: "child", name: "Helper", status: "created" }, "Helper"],
  [
    {
      kind: "cloud_agent",
      agentId: "agent",
      title: "Fix",
      status: "running",
      url: "https://example.test",
    },
    "Fix",
  ],
  [
    {
      kind: "skill_draft",
      skillId: "skill",
      name: "Release",
      goal: "Publish",
      status: "draft",
      playbook: {
        whenToUse: "",
        inputs: [],
        steps: [],
        howToCheck: "",
        whatToReturn: "",
        approvalBoundaries: "",
        failureHandling: "",
      },
    },
    "Release",
  ],
  [
    {
      kind: "mcp_approval",
      name: "Tools",
      serverId: "server",
      transport: "streamable_http",
      endpoint: null,
      needsOAuth: false,
      status: "pending",
    },
    "Tools",
  ],
  [
    { kind: "image", artifactId: "image", name: "diagram.png", mimeType: "image/png" },
    "diagram.png",
  ],
  [
    { kind: "file", artifactId: "file", name: "notes.txt", mimeType: "text/plain", size: 12 },
    "notes.txt",
  ],
  [{ kind: "handoff", fromBotId: "one", toBotId: "two", text: "Please review" }, "Please review"],
  [
    { kind: "bot_message_sent", toBotId: "two", toBotName: "Helper", text: "Check this" },
    "Check this",
  ],
  [
    { kind: "bot_message_received", fromBotId: "two", fromBotName: "Helper", text: "Checked" },
    "Checked",
  ],
];

it.each(visibleBlocks)("previews a visible $kind block", (block, expected) => {
  expect(messageReplyExcerpt([block], "bot")).toBe(expected);
});
it("prefers narration over attachments and bounds every block's preview", () => {
  expect(
    messageReplyExcerpt(
      [
        { kind: "image", artifactId: "image", name: "diagram.png", mimeType: "image/png" },
        ...textBlock("Caption"),
      ],
      "user",
    ),
  ).toBe("Caption");
  expect(messageReplyExcerpt([{ kind: "ask", text: `${"a".repeat(279)}😀more` }], "bot")).toBe(
    "a".repeat(279),
  );
  expect(
    messageReplyExcerpt(
      [{ kind: "image", artifactId: "image", name: "", mimeType: "image/png" }],
      "user",
    ),
  ).toBe("[image: ]");
});

it("keeps image metadata with caption text and avoids agent placeholders in UI", () => {
  const image: MessageBlock = {
    kind: "image",
    artifactId: "photo",
    name: "",
    mimeType: "image/png",
  };
  expect(messageReplyPreview([image], "user")).toEqual({
    role: "user",
    text: "",
    attachment: image,
  });
  expect(messageReplyPreview([image, ...textBlock("**Caption**")], "bot").text).toBe("Caption");
  expect(messageReplyExcerpt([image], "user")).toBe("[image: ]");
});

it("keeps a filename in file-only previews for older clients", () => {
  const file: MessageBlock = {
    kind: "file",
    artifactId: "notes",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 12,
  };
  expect(messageReplyPreview([file], "user").text).toBe("notes.txt");
  expect(messageReplyPreview([file, ...textBlock("Caption")], "user").text).toBe("Caption");
});

describe("a retired import checklist", () => {
  it("gives no reply excerpt", () => {
    const item = { kind: "routine" as const, routineId: "routine-1", name: "morning" };
    for (const block of [
      { kind: "import_setup", items: [], undone: true },
      { kind: "import_setup", items: [item], undone: true },
    ] satisfies MessageBlock[]) {
      expect(messageReplyExcerpt([block], "bot")).toBe("");
      expect(messageReplyPreview([block], "bot").text).toBe("");
    }
    // A live one is still quoted by its items.
    expect(messageReplyExcerpt([{ kind: "import_setup", items: [item] }], "bot")).toBe("morning");
  });
});
