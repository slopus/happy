import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;

const flowchart = [
  "Here is the contribution flow:",
  "",
  "```mermaid",
  "graph LR",
  "  A[Clone repo] --> B[Branch] --> C[Tests] --> D[Pull request]",
  "```",
  "",
  "Each step runs in CI.",
].join("\n");

const sequence = [
  "```mermaid",
  "sequenceDiagram",
  "  accTitle: Approval round trip",
  "  participant U as User",
  "  participant B as Bot",
  "  U->>B: Book the flight",
  "  B-->>U: Needs approval",
  "  U->>B: Approve",
  "  Note over B: Books and reports back",
  "```",
].join("\n");

const invalid = [
  "```mermaid",
  "graph LR",
  "  A[Unclosed --> B",
  "```",
  "",
  "```ts",
  "const ok = true;",
  "```",
].join("\n");

const plain = "No diagram here, only `code` and a fence:\n\n```ts\nconst ok = true;\n```";

const wide = [
  "```mermaid",
  "graph LR",
  "  A[Collect requirements] --> B[Write the spec] --> C[Review the spec] --> D[Build it]",
  "  D --> E[Test it] --> F[Ship it] --> G[Watch the metrics]",
  "```",
].join("\n");

const prose = [
  "Here is the email I would send:",
  "",
  "```text",
  "Dear Ana,",
  "",
  "Thanks for the walkthrough on Thursday. I collected the open questions from the team and grouped them by area, so we can work through them in one pass on our next call instead of trading short replies all week.",
  "",
  "The staging deploy still fails on the migration that renames the audit table, and the rollback script references a column we removed in the last release, so I would start there before anything else on the list.",
  "```",
  "",
  "The check that fails:",
  "",
  "```ts",
  'expect(await auditTable.page(1).columns()).toContain("actor_id"); // fails: renamed in migration 0187',
  "```",
].join("\n");

const cases: Record<string, string> = { flowchart, sequence, invalid, plain, wide, prose };
const initialMarkdown = cases[params.get("case") ?? "flowchart"] ?? flowchart;

function Fixture() {
  const [message, setMessage] = useState({
    markdown: initialMarkdown,
    streaming: params.has("stream"),
  });

  useEffect(() => {
    const update = (event: Event) => {
      setMessage((event as CustomEvent<{ markdown: string; streaming: boolean }>).detail);
    };
    window.addEventListener("rk-diagram-stream-update", update);
    return () => window.removeEventListener("rk-diagram-stream-update", update);
  }, []);

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div
        data-testid="diagram-fixture"
        className="rounded-2xl bg-muted px-4 py-3"
        style={{ maxWidth: "40rem" }}
      >
        <ChatMarkdown streaming={message.streaming}>{message.markdown}</ChatMarkdown>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
