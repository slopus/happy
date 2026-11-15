import type { MessageBlock } from "@rakazo/contracts";

const TOPICS = [
  "the onboarding funnel",
  "the billing webhook retries",
  "the weekly support digest",
  "the deploy checklist",
  "the search index rebuild",
  "the vendor contract renewal",
  "the mobile release notes",
  "the customer import job",
];

/**
 * Deterministic chat history for the web chat benchmark: mostly short exchanges, with markdown,
 * code, tables, tool steps, and helper results mixed in, and an ~11 KB reply every 25 turns
 * like the heaviest real messages.
 */
export function benchmarkThreadMessages(count: number) {
  const messages: Array<{ role: "user" | "bot"; blocks: MessageBlock[] }> = [];
  for (let index = 0; index < count; index += 1) {
    const turn = Math.floor(index / 2);
    messages.push(
      index % 2 === 0
        ? { role: "user", blocks: [{ kind: "text", text: userText(turn) }] }
        : { role: "bot", blocks: botBlocks(turn, index === count - 1) },
    );
  }
  return messages;
}

/** The reply streamed in the streaming scenario; it ends in STREAM_END so its last paint is visible. */
export const STREAM_END = "End of the streamed report.";
export const STREAMED_REPLY = `${heavyMarkdown(7)}\n\n${STREAM_END}`;

/** Splits text into `count` nearly equal chunks, the way a model streams tokens in batches. */
export function streamChunks(text: string, count: number) {
  const size = Math.ceil(text.length / count);
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

function topic(turn: number) {
  return TOPICS[turn % TOPICS.length]!;
}

function userText(turn: number) {
  if (turn % 7 === 3) {
    return [
      `Can you look into ${topic(turn)} again?`,
      "Last time the numbers looked off for the second half of the month, and I want to understand whether that was a data problem or a real change.",
      "If it is a data problem, tell me which step dropped rows.",
    ].join(" ");
  }
  return turn % 3 === 0
    ? `What changed in ${topic(turn)} since yesterday?`
    : `Thanks. Next, summarize ${topic(turn)} in a few bullets.`;
}

function botBlocks(turn: number, last: boolean): MessageBlock[] {
  // The final reply is plain markdown so its row is always drawn on its own.
  if (last) return [{ kind: "text", text: mediumMarkdown(turn) }];
  if (turn % 25 === 12) return [{ kind: "text", text: heavyMarkdown(turn) }];
  switch (turn % 10) {
    case 4:
    case 5:
      return [{ kind: "text", text: mediumMarkdown(turn) }];
    case 6:
      return [{ kind: "text", text: codeMarkdown(turn) }];
    case 7:
      return [{ kind: "text", text: tableMarkdown(turn) }];
    case 8:
      return [
        {
          kind: "steps",
          steps: [
            { label: "Searched the web", count: 2 },
            { label: "Read a file", count: 3, note: `Checking ${topic(turn)} first.` },
            { label: "Ran a command", count: 1 },
          ],
          durationMs: 4_200 + turn,
        },
        { kind: "text", text: `Done. ${topic(turn)} is back to normal and the checks pass.` },
      ];
    case 9:
      return [
        {
          kind: "subagent",
          agentId: `helper-${turn}`,
          name: "researcher",
          task: `Collect the open questions about ${topic(turn)}`,
          status: "completed",
          result: "Three open questions, all about ownership of the follow-up work.",
        },
        { kind: "text", text: "The helper finished; the open questions are about ownership." },
      ];
    default:
      return [
        {
          kind: "text",
          text:
            turn % 2 === 0
              ? `Nothing new in ${topic(turn)} since yesterday.`
              : `Sure. ${topic(turn)} looks healthy; the only change is a smaller backlog.`,
        },
      ];
  }
}

function mediumMarkdown(turn: number) {
  return [
    `### ${capitalize(topic(turn))}`,
    `Here is where **${topic(turn)}** stands after turn ${turn + 1}.`,
    "",
    "- Volume is steady week over week",
    "- Two edge cases still fail; both are tracked",
    `- The fix ships behind \`feature_${turn % 13}\` this week`,
    "",
    "See the [runbook](https://example.test/runbook) for the rollback steps.",
  ].join("\n");
}

function codeMarkdown(turn: number) {
  return [
    `The retry helper for ${topic(turn)} should back off like this:`,
    "",
    "```ts",
    "export async function withRetry<T>(work: () => Promise<T>, attempts = 4): Promise<T> {",
    "  let lastError: unknown;",
    "  for (let attempt = 1; attempt <= attempts; attempt += 1) {",
    "    try {",
    "      return await work();",
    "    } catch (error) {",
    "      lastError = error;",
    "      const delayMs = Math.min(30_000, 2 ** attempt * 250);",
    "      await new Promise((resolve) => setTimeout(resolve, delayMs));",
    "    }",
    "  }",
    "  throw lastError;",
    "}",
    "```",
    "",
    "It keeps the total wait under a minute.",
  ].join("\n");
}

function tableMarkdown(turn: number) {
  const rows = Array.from({ length: 6 }, (_, row) => {
    const value = (turn * 37 + row * 11) % 100;
    return `| Week ${row + 1} | ${value} | ${100 - value} | ${row % 2 ? "on track" : "at risk"} |`;
  });
  return [
    `Weekly view of ${topic(turn)}:`,
    "",
    "| Week | Done | Open | Status |",
    "| --- | ---: | ---: | --- |",
    ...rows,
    "",
    "Weeks marked at risk have more than one blocked item.",
  ].join("\n");
}

function heavyMarkdown(turn: number) {
  const section = (index: number) =>
    [
      `## Part ${index + 1}: ${capitalize(TOPICS[(turn + index) % TOPICS.length]!)}`,
      "The audit walked every step of the pipeline, compared the input and output counts, and checked each transformation against its specification. Most steps matched exactly; the differences below are the ones that matter.",
      "",
      "1. The import job skipped rows whose timestamps were in the future.",
      "2. The deduplication step merged accounts that only shared an email domain.",
      "3. The export truncated notes longer than 4,000 characters.",
      "",
      "```sql",
      "SELECT account_id, count(*) AS events, max(created_at) AS latest",
      "FROM events",
      "WHERE created_at >= now() - interval '30 days'",
      "GROUP BY account_id",
      "HAVING count(*) > 100",
      "ORDER BY events DESC",
      "LIMIT 50;",
      "```",
      "",
      "| Step | Rows in | Rows out | Note |",
      "| --- | ---: | ---: | --- |",
      `| Import | ${12_000 + index} | ${11_950 + index} | future timestamps |`,
      `| Deduplicate | ${11_950 + index} | ${11_400 + index} | domain merge |`,
      `| Export | ${11_400 + index} | ${11_400 + index} | notes truncated |`,
      "",
      "> Fixing the deduplication rule first recovers most of the missing accounts.",
    ].join("\n");
  return [
    `# Audit of ${topic(turn)}`,
    ...Array.from({ length: 11 }, (_, index) => section(index)),
    "**Next step:** ship the deduplication fix, then re-run the import for the affected month.",
  ].join("\n\n");
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
