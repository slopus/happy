import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { instructionUpdateDiff } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import type { ResolvedAppearance } from "../../src/lib/ui-appearance";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import "../../src/styles.css";
import { BOT, FixtureTranscript } from "./thread-fixture";

// Every chat surface over fake data, so consistency can be checked without a backend.
// State lives in the URL (?scenario=&theme=&width=&tools=) so any view can be linked.

const SCOUT = { botId: "bot-2", name: "Scout", color: botColor("green") };
const LEDGER = { botId: "bot-3", name: "Ledger", color: botColor("red") };

function botColor(id: string) {
  return BOT_COLOR_LIST.find((color) => color.id === id)!.hex;
}

let seq = 0;
function message(
  role: ThreadMessage["role"],
  blocks: MessageBlock[],
  extra: Partial<ThreadMessage> = {},
): ThreadMessage {
  seq += 1;
  return {
    id: `message-${seq}`,
    threadId: "thread-1",
    seq,
    role,
    blocks,
    ...(role === "bot" ? { botId: BOT.botId } : {}),
    createdAt: new Date(Date.UTC(2026, 9, 26, 9, seq)).toISOString(),
    ...extra,
  };
}
const user = (text: string, extra?: Partial<ThreadMessage>) =>
  message("user", [{ kind: "text", text }], extra);
const bot = (blocks: MessageBlock[], extra?: Partial<ThreadMessage>) =>
  message("bot", blocks, extra);
const say = (text: string, extra?: Partial<ThreadMessage>) => bot([{ kind: "text", text }], extra);

type Scenario = {
  id: string;
  label: string;
  messages: ThreadMessage[];
  running?: boolean;
  bots?: GroupAvatarMember[];
  /** Asks that render as no longer active instead of taking an answer. */
  inactiveAsks?: string[];
};

const greeting = user("Can you get the Q3 report ready for Monday?");
const reply = say(
  "Sure. Here's the plan:\n\n1. Pull revenue and churn from the **finance sheet**\n2. Draft the summary\n3. Send it to you for review\n\nI'll use the [Q3 template](https://example.test/template) and `report.md` as the starting point.",
);
const conversation: Scenario = {
  id: "conversation",
  label: "Conversation",
  messages: [
    greeting,
    reply,
    user("Keep the summary short.", {
      replyToMessageId: reply.id,
      replyQuote: "Draft the summary",
      replyPreview: { role: "bot", botId: BOT.botId, text: "Draft the summary" },
    }),
    say("Got it, one paragraph."),
    bot([
      {
        kind: "card",
        lines: [
          { k: "Report", v: "Q3 summary" },
          { k: "Due", v: "Monday 9:00" },
          { k: "Reviewer", v: "You" },
        ],
      },
    ]),
    bot([{ kind: "meta", text: "Reminder set for Monday 8:30" }]),
    say(
      "| Metric | Q2 | Q3 |\n| --- | ---: | ---: |\n| Revenue | 1.2M | 1.4M |\n| Churn | 3.1% | 2.7% |\n\n```ts\nconst growth = (q3 - q2) / q2;\n```",
    ),
  ],
};

const options = bot([
  {
    kind: "ask",
    text: "Hi there! I'm Chief. What do you want me to help with?",
    status: "pending",
    actions: [
      { id: "lead", label: "Lead and coordinate my team's work" },
      { id: "research", label: "Research and summarize information" },
      { id: "plan", label: "Plan and track projects" },
      { id: "other", label: "Something else (I'll type it)" },
    ],
  },
]);
const stale = bot([
  {
    kind: "ask",
    text: "Which calendar should I use?",
    status: "pending",
    actions: [
      { id: "work", label: "Work" },
      { id: "personal", label: "Personal" },
    ],
  },
]);
const questions: Scenario = {
  id: "questions",
  label: "Questions",
  inactiveAsks: [stale.id],
  messages: [
    options,
    bot([
      {
        kind: "ask",
        text: "Which city should I use?",
        status: "answered",
        answer: "seoul",
        actions: [
          { id: "berlin", label: "Berlin" },
          { id: "seoul", label: "Seoul" },
        ],
      },
    ]),
    bot([
      {
        kind: "ask",
        text: "Where should we meet?",
        status: "answered",
        answer: "Paris",
        actions: [
          { id: "berlin", label: "Berlin" },
          { id: "seoul", label: "Seoul" },
        ],
      },
    ]),
    user("Paris"),
    stale,
    bot([
      {
        kind: "ask",
        text: "Here's the reply I drafted. Send it?",
        detail: "Thanks Sam, Tuesday at 2 pm works for me.",
        detailFormat: "text",
        status: "pending",
      },
    ]),
    bot([
      {
        kind: "choice",
        question: "What do you want me on first?",
        options: [
          { id: "inbox", letter: "A", label: "Inbox & email" },
          { id: "calendar", letter: "B", label: "Calendar" },
          { id: "research", letter: "C", label: "Research" },
        ],
      },
    ]),
    bot([
      {
        kind: "choice",
        question: "How often should I check in?",
        options: [
          { id: "daily", letter: "A", label: "Daily" },
          { id: "weekly", letter: "B", label: "Weekly" },
        ],
        answerId: "weekly",
      },
    ]),
  ],
};

const approvalActions = [
  { id: "allow", label: "Allow once" },
  { id: "always", label: "Always allow this tool" },
  { id: "deny", label: "Deny" },
];
const approvals: Scenario = {
  id: "approvals",
  label: "Approvals",
  messages: [
    bot([
      {
        kind: "ask",
        approvalEffectId: "effect-1",
        text: "Send this email from your inbox?",
        detail: "To: sam@example.test\nSubject: Re: Q3 report\n\nAttached is the draft.",
        status: "pending",
        actions: approvalActions,
      },
    ]),
    bot([
      {
        kind: "ask",
        approvalEffectId: "effect-2",
        text: "Open a page on example.test?",
        site: "example.test",
        status: "pending",
        actions: approvalActions,
      },
    ]),
    bot([
      {
        // As the adapters' purchase card words a pay click, with the order lines the page lists.
        kind: "ask",
        approvalEffectId: "effect-6",
        text: "Pay on freshcart.test?",
        detail: [
          'Button: "Place order"',
          "Bananas × 6: $3.00",
          "Oat milk 1L × 2: $8.40",
          "Delivery: $6.00",
          "Total on the page: $17.40",
          "The button label, items and total are read from the page. The bot has not checked them.",
        ].join("\n"),
        detailFormat: "text",
        receipt: {
          button: "Place order",
          items: [
            { name: "Bananas × 6", amount: "$3.00" },
            { name: "Oat milk 1L × 2", amount: "$8.40" },
            { name: "Delivery", amount: "$6.00" },
          ],
          amount: "$17.40",
          amountSource: "page",
        },
        status: "pending",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    ]),
    bot([
      {
        kind: "ask",
        approvalEffectId: "effect-3",
        text: "Create the space Marketing?",
        status: "pending",
        actions: [
          { id: "allow", label: "Create space", outcome: "created" },
          { id: "deny", label: "Cancel", outcome: "cancelled" },
        ],
      },
    ]),
    bot([
      {
        kind: "ask",
        approvalEffectId: "effect-5",
        text: "Update instructions?",
        status: "pending",
        instructionUpdate: {
          botId: BOT.botId,
          before: "Reply in English.",
          after: "Reply in English. Keep summaries to one paragraph.",
          reason: "You asked for shorter summaries.",
        },
        detail: instructionUpdateDiff(
          "Reply in English.",
          "Reply in English. Keep summaries to one paragraph.",
        ),
        detailFormat: "code",
        actions: [
          { id: "allow", label: "Apply" },
          { id: "deny", label: "Dismiss" },
        ],
      },
    ]),
    bot([
      {
        kind: "ask",
        text: "Instructions updated",
        status: "answered",
        answer: "allow",
        instructionUpdate: {
          botId: BOT.botId,
          before: "Reply in English.",
          after: "Reply in English. Be brief.",
          reason: "You asked for brevity.",
          undoVersionId: "version-1",
        },
      },
    ]),
    bot([
      {
        kind: "ask",
        text: "Settings updated",
        status: "answered",
        settingsUpdate: {
          botId: BOT.botId,
          before: { modelProvider: "anthropic", modelId: "claude-haiku-5.5", thinkingLevel: "low" },
          after: {
            modelProvider: "anthropic",
            modelId: "claude-sonnet-5.5",
            thinkingLevel: "high",
          },
        },
      },
    ]),
    bot([
      {
        kind: "ask",
        approvalEffectId: "effect-4",
        text: "Delete 12 archived files?",
        status: "answered",
        answer: "deny",
        actions: approvalActions,
      },
    ]),
  ],
};

const secrets: Scenario = {
  id: "secrets",
  label: "Secrets",
  messages: [
    bot([
      {
        kind: "ask",
        text: "Enter the code sent to your phone.",
        input: "secret",
        purpose: "otp",
        status: "pending",
      },
    ]),
    bot([
      {
        kind: "ask",
        text: "I need an API key for the analytics service.",
        input: "secret",
        purpose: "api_key",
        credential: { name: "ANALYTICS_KEY", origin: "", auth: { type: "command" } },
        status: "pending",
      },
    ]),
    bot([
      {
        kind: "ask",
        text: "Sign in to the vendor portal.",
        input: "secret",
        purpose: "password",
        credential: {
          name: "vendor-portal",
          origin: "https://portal.example.test",
          auth: { type: "login" },
        },
        loginFields: ["ID number", "Phone number", "PIN"],
        status: "pending",
      },
    ]),
    bot([
      {
        kind: "ask",
        text: "Enter the code sent to your phone.",
        input: "secret",
        purpose: "otp",
        status: "answered",
        answer: "",
      },
    ]),
  ],
};

const working: Scenario = {
  id: "working",
  label: "Working",
  running: true,
  messages: [
    user("Find time with Sam next week."),
    bot([
      {
        kind: "steps",
        steps: [
          { label: "Open calendar", count: 1 },
          { label: "Read events", count: 3 },
          { label: "Search inbox", count: 2 },
        ],
        durationMs: 8_200,
      },
    ]),
    bot([
      {
        kind: "subagent",
        agentId: "agent-1",
        name: "Researcher",
        task: "Compare three venues",
        status: "completed",
        result: "The Loft is cheapest and free on Tuesday.",
      },
    ]),
    bot([
      {
        kind: "subagent",
        agentId: "agent-2",
        name: "Writer",
        task: "Draft the invite",
        status: "running",
        progress: "Writing the second paragraph",
      },
    ]),
    bot([
      {
        kind: "subagent",
        agentId: "agent-3",
        name: "Booker",
        task: "Reserve the room",
        status: "failed",
        result: "The booking site timed out.",
      },
    ]),
    bot([
      {
        kind: "cloud_agent",
        agentId: "cloud-1",
        title: "Fix flaky calendar test",
        status: "running",
        url: "https://example.test/agents/cloud-1",
        branch: "fix/calendar-test",
      },
    ]),
    bot([
      {
        kind: "cloud_agent",
        agentId: "cloud-2",
        title: "Add CSV export",
        status: "finished",
        url: "https://example.test/agents/cloud-2",
        prUrl: "https://example.test/pull/42",
      },
    ]),
    bot(
      [
        {
          kind: "computer",
          state: "Needs you",
          text: "Sign in to Harbor Bookings, then hand it back.",
        },
      ],
      { runId: "run-sign-in" },
    ),
    bot([{ kind: "computer", state: "Working", text: "Filling in the booking form." }]),
    bot([
      { kind: "computer", state: "Done", text: "Sign in to the booking site, then hand it back." },
    ]),
    bot([{ kind: "progress", text: "Checking Sam's calendar…" }]),
  ],
};

const team: Scenario = {
  id: "team",
  label: "Team",
  bots: [BOT, SCOUT, LEDGER],
  messages: [
    user("Plan the offsite with the team."),
    bot([
      {
        kind: "bot_message_sent",
        toBotId: SCOUT.botId,
        toBotName: SCOUT.name,
        text: "Find three venues near the office.",
        intent: "request",
      },
    ]),
    message("user", [
      {
        kind: "bot_message_received",
        fromBotId: SCOUT.botId,
        fromBotName: SCOUT.name,
        text: "The Loft, Harbor Hall and Pine Room are free.",
        intent: "result",
      },
    ]),
    bot([
      {
        kind: "handoff",
        fromBotId: BOT.botId,
        toBotId: LEDGER.botId,
        text: "Budget check",
      },
    ]),
    say("The Loft fits the budget.", { botId: LEDGER.botId }),
    bot([
      {
        kind: "channel_message",
        provider: "telegram",
        channelId: "channel-1",
        fromAddress: "@sam",
        fromLabel: "Sam",
        text: "Tuesday works for me",
      },
    ]),
    bot([{ kind: "child_bot", botId: SCOUT.botId, name: SCOUT.name, status: "created" }]),
    bot([{ kind: "child_bot", botId: LEDGER.botId, name: LEDGER.name, status: "archived" }]),
  ],
};

const rich: Scenario = {
  id: "rich",
  label: "Rich content",
  messages: [
    message("user", [
      { kind: "image", artifactId: "image-1", mimeType: "image/svg+xml", name: "whiteboard.svg" },
    ]),
    bot([
      {
        kind: "file",
        artifactId: "file-1",
        mimeType: "application/pdf",
        name: "q3-report.pdf",
        size: 184_320,
      },
    ]),
    bot([
      {
        kind: "chart",
        name: "Revenue by month",
        spec: { marks: [{ type: "barY", options: { x: "month", y: "revenue" } }] },
        data: [
          { month: "Jul", revenue: 410 },
          { month: "Aug", revenue: 465 },
          { month: "Sep", revenue: 520 },
        ],
      },
    ]),
    bot([
      {
        kind: "app_connect",
        provider: "notion",
        name: "Notion",
        description: "Read and update your pages",
        logo: null,
        status: "pending",
      },
    ]),
    bot([
      {
        kind: "app_connect",
        provider: "linear",
        name: "Linear",
        description: "Track issues",
        logo: null,
        status: "connected",
      },
    ]),
    bot([
      {
        kind: "mcp_approval",
        name: "Weather",
        serverId: "server-1",
        transport: "streamable_http",
        endpoint: "https://weather.example.test/mcp",
        needsOAuth: false,
        status: "pending",
      },
    ]),
    bot([
      {
        kind: "skill_draft",
        skillId: "skill-1",
        name: "Weekly report",
        goal: "Send a summary of the week every Friday",
        playbook: {
          whenToUse: "Fridays at 4 pm",
          inputs: ["Calendar", "Inbox"],
          steps: ["Collect the week's meetings", "Summarize decisions", "Email the summary"],
          howToCheck: "Every meeting is covered",
          whatToReturn: "A short email",
          approvalBoundaries: "Ask before sending",
          failureHandling: "Tell me what was missing",
        },
        status: "draft",
      },
    ]),
  ],
};

// Call messages carry their callId; the transcript groups a call's turns into one card.
const calls: Scenario = {
  id: "calls",
  label: "Calls",
  messages: [
    bot(
      [
        {
          kind: "voice_call",
          callId: "call-paginated",
          title: "Deploy check",
          farewell: "Bye",
          durationSeconds: 125,
        },
      ],
      { callId: "call-paginated", runId: "run-paginated" },
    ),
    say("Here is the deployment checklist.", { runId: "run-paginated" }),
    bot(
      [
        {
          kind: "call_request",
          callId: "call-1",
          reason: "The venue needs an answer today",
          opening: "Hi, quick question about the venue.",
          status: "ringing",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
      { callId: "call-1" },
    ),
    bot(
      [
        {
          kind: "call_request",
          callId: "call-2",
          reason: "Confirm the budget",
          opening: "Hi, about the budget.",
          status: "missed",
          expiresAt: "2026-10-26T09:30:00.000Z",
        },
      ],
      { callId: "call-2" },
    ),
    user("Can we go over the offsite?", { callId: "call-3", runId: "run-3" }),
    say("Sure. The Loft is booked for Tuesday.", { callId: "call-3", runId: "run-3" }),
    bot(
      [
        {
          kind: "voice_call",
          callId: "call-3",
          title: "Offsite planning",
          farewell: "Talk soon.",
          durationSeconds: 184,
        },
      ],
      { callId: "call-3" },
    ),
  ],
};

// Every markdown style a reply can use, so type and weight changes can be judged in one place.
const textStyles: Scenario = {
  id: "text-styles",
  label: "Text styles",
  messages: [
    user("Show me the text styles you can use."),
    say(
      [
        "# Heading 1",
        "## Heading 2",
        "### Heading 3",
        "A plain paragraph that runs long enough to wrap, so line height and measure show the way a real answer reads.",
        "**Bold**, *italic*, ***bold italic***, ~~strikethrough~~, `inline code` and a [link](https://example.test).",
        "> A blockquote that also runs long enough to wrap onto a second line.",
        "- A bullet\n- Another bullet\n  - A nested bullet",
        "1. **A bold lead-in:** then the rest of the item, long enough to wrap.\n2. A second item",
        "| Plan | Price |\n| --- | --- |\n| Free | $0 |\n| Pro | $20 |",
        '```\nconst greeting = "hello";\n```',
        "---",
        "A closing paragraph after a rule.",
      ].join("\n\n"),
    ),
  ],
};

const SCENARIOS: Scenario[] = [
  conversation,
  textStyles,
  questions,
  approvals,
  secrets,
  working,
  team,
  rich,
  calls,
];

const IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#d4d4d4"/><circle cx="160" cy="150" r="70" fill="#a3a3a3"/><rect x="250" y="90" width="150" height="120" rx="12" fill="#737373"/></svg>`;

/** A browser on a sign-in page, as a computer card's still of the screen. */
const SCREEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" font-family="Helvetica,Arial,sans-serif"><rect width="1280" height="800" fill="#f5f5f7"/><rect width="1280" height="40" fill="#dfe1e5"/><rect x="12" y="8" width="240" height="32" rx="8" fill="#fff"/><text x="28" y="29" font-size="14" fill="#333">Sign in - Harbor Bookings</text><rect y="40" width="1280" height="48" fill="#fff"/><rect x="96" y="50" width="1088" height="28" rx="14" fill="#f1f3f4"/><text x="116" y="69" font-size="14" fill="#444">bookings.example.test/login</text><rect x="450" y="210" width="380" height="380" rx="16" fill="#fff" stroke="#e3e3e8"/><text x="482" y="262" font-size="26" font-weight="700" fill="#111">Welcome back</text><text x="482" y="290" font-size="15" fill="#666">Sign in to manage your reservations.</text><text x="482" y="334" font-size="13" fill="#444">Email</text><rect x="482" y="344" width="316" height="40" rx="8" fill="#fff" stroke="#ccc"/><text x="482" y="414" font-size="13" fill="#444">Password</text><rect x="482" y="424" width="316" height="40" rx="8" fill="#fff" stroke="#ccc"/><rect x="482" y="500" width="316" height="44" rx="8" fill="#2457f5"/><text x="640" y="528" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">Sign in</text><rect y="764" width="1280" height="36" fill="#1f2023"/><text x="1250" y="787" font-size="13" fill="#ccc" text-anchor="end">4:19 PM</text></svg>`;

// The page has no API; answer the few reads cards make on mount with fake data.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.pathname === "/rpc/artifacts/get")
    return Response.json({
      json: { contentBase64: btoa(IMAGE_SVG), mimeType: "image/svg+xml" },
    });
  if (url.pathname === "/rpc/computer/preview")
    return Response.json({ json: { image: `data:image/svg+xml;base64,${btoa(SCREEN_SVG)}` } });
  if (url.pathname.startsWith("/rpc/"))
    return Response.json({ json: { message: "Not available in the gallery" } }, { status: 503 });
  return realFetch(input, init);
};

type Width = "desktop" | "phone";
type View = { scenario: string; theme: ResolvedAppearance; width: Width; tools: boolean };

const params = new URLSearchParams(location.search);
/** The phone preview loads the page again in a 390px iframe, so breakpoints match a real phone. */
const embedded = params.has("embed");

function readView(): View {
  return {
    scenario: params.get("scenario") ?? SCENARIOS[0]!.id,
    theme: params.get("theme") === "light" ? "light" : "dark",
    width: params.get("width") === "phone" ? "phone" : "desktop",
    tools: params.get("tools") !== "off",
  };
}

function viewQuery(view: View) {
  return new URLSearchParams({
    scenario: view.scenario,
    theme: view.theme,
    width: view.width,
    tools: view.tools ? "on" : "off",
  }).toString();
}

function ScenarioTranscript({ view }: { view: View }) {
  const scenario = SCENARIOS.find((item) => item.id === view.scenario) ?? SCENARIOS[0]!;
  const answerable = new Set(
    scenario.messages
      .filter((item) => !scenario.inactiveAsks?.includes(item.id))
      .map((item) => item.id),
  );
  return (
    <FixtureTranscript
      key={scenario.id}
      messages={scenario.messages}
      running={scenario.running ?? false}
      showToolActivity={view.tools}
      answerableAskIds={answerable}
      bots={scenario.bots}
    />
  );
}

function Gallery() {
  const [view, setView] = useState(readView);

  useEffect(() => {
    applyResolvedAppearance(view.theme);
    if (!embedded) history.replaceState(null, "", `?${viewQuery(view)}`);
  }, [view]);

  if (embedded) return <ScenarioTranscript view={view} />;

  const update = (next: Partial<View>) => setView((current) => ({ ...current, ...next }));
  const toggle = (label: string, pressed: boolean, onClick: () => void) => (
    <Button
      size="sm"
      variant={pressed ? "secondary" : "ghost"}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {label}
    </Button>
  );

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border p-2">
        {SCENARIOS.map((item) => (
          <Button
            key={item.id}
            variant={item.id === view.scenario ? "secondary" : "ghost"}
            className="justify-start"
            aria-current={item.id === view.scenario ? "page" : undefined}
            onClick={() => update({ scenario: item.id })}
          >
            {item.label}
          </Button>
        ))}
        <div className="mt-auto flex flex-col gap-0.5">
          {toggle("Dark", view.theme === "dark", () =>
            update({ theme: view.theme === "dark" ? "light" : "dark" }),
          )}
          {toggle("Phone width", view.width === "phone", () =>
            update({ width: view.width === "phone" ? "desktop" : "phone" }),
          )}
          {toggle("Tool activity", view.tools, () => update({ tools: !view.tools }))}
        </div>
      </nav>
      <div data-testid="gallery-frame" className="flex min-w-0 flex-1 justify-center">
        {view.width === "phone" ? (
          <iframe
            key={viewQuery(view)}
            title="Phone preview"
            src={`?${viewQuery(view)}&embed`}
            className="box-content h-full w-[390px] border-x border-border"
          />
        ) : (
          <div className="min-w-0 flex-1">
            <ScenarioTranscript view={view} />
          </div>
        )}
      </div>
    </div>
  );
}

await bootstrapI18n("en");
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <QueryClientProvider client={queryClient}>
      <Gallery />
    </QueryClientProvider>
  </I18nProvider>,
);
