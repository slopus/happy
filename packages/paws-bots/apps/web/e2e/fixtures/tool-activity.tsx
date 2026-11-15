import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import { rpc } from "../../src/lib/rpc";
import { toolActivityPreference } from "../../src/lib/tool-activity-preference";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "settings" ? "settings" : "thread";
const live = params.get("phase") === "live";

const USER_TEXT = "Find a free slot on Tuesday.";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const STEP_LABELS = [
  "Open calendar",
  "Read events",
  "Search inbox",
  "Read message",
  "Check time zones",
  "Compare calendars",
  "Draft invite",
  "Check conflicts",
];

const NOTE_TEXT = "Anna is free all Tuesday afternoon.";

const stepsBlock: MessageBlock = {
  kind: "steps",
  steps: STEP_LABELS.map((label) => ({
    label,
    count: 1,
    // A finished reply keeps what the bot wrote before a step on that step.
    ...(!live && label === "Check conflicts" ? { note: NOTE_TEXT } : {}),
  })),
  ...(live ? {} : { durationMs: 12_400 }),
};

const createdAt = "2026-08-16T00:00:01.000Z";

// A live run that has only called tools so far, or the finished reply with its tool card.
const messages: ThreadMessage[] = [
  {
    id: "user-1",
    threadId: "thread-1",
    seq: 1,
    role: "user",
    blocks: [{ kind: "text", text: USER_TEXT }],
    createdAt,
  },
  {
    id: live ? "progress:run-1" : "bot-reply",
    threadId: "thread-1",
    seq: 2,
    role: "bot",
    blocks: live ? [stepsBlock] : [stepsBlock, { kind: "text", text: REPLY_TEXT }],
    botId: "bot-1",
    runId: "run-1",
    createdAt,
  },
];

function ThreadFixture() {
  const showToolActivity = toolActivityPreference.use();
  return (
    <FixtureTranscript messages={messages} running={live} showToolActivity={showToolActivity} />
  );
}

function SettingsFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SettingsOverlay
        shellRpc={rpc}
        email="owner@example.test"
        name="Owner"
        memoryConfig={null}
        onMemoryConfigChange={() => {}}
        onUsageOpen={() => {}}
        timezone="UTC"
        onTimezoneChange={async () => {}}
        onClose={() => {}}
        section="general"
        onSectionChange={() => {}}
      />
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        {view === "settings" ? <SettingsFixture /> : <ThreadFixture />}
      </I18nProvider>
    </QueryClientProvider>,
  );
});
