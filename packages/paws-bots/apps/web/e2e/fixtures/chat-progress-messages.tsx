import { I18nProvider } from "@lingui/react";
import type { ProductEvent } from "@rakazo/contracts";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";
import { FixtureTranscript, reduceThreadEvents } from "./thread-fixture";

const live = new URLSearchParams(location.search).get("live") === "1";

// A bot posts a message_user update mid-turn, keeps calling tools, then replies.
const midTurn: Partial<ProductEvent>[] = [
  {
    type: "thread.message.created",
    payload: {
      messageId: "user-1",
      role: "user",
      blocks: [{ kind: "text", text: "Find time with Sam next week." }],
    },
  },
  { type: "run.started", payload: { trigger: "user" } },
  {
    type: "thread.message.created",
    payload: {
      messageId: "bot-progress",
      role: "bot",
      blocks: [{ kind: "text", text: "Checking your calendars…" }],
    },
  },
  { type: "agent.tool.called", payload: { name: "calendar" } },
];
const events: Partial<ProductEvent>[] = live
  ? [
      ...midTurn,
      { type: "thread.progress", payload: { text: "Still finding a free slot…", streaming: true } },
    ]
  : [
      ...midTurn,
      {
        type: "thread.message.created",
        payload: {
          messageId: "bot-reply",
          role: "bot",
          blocks: [{ kind: "text", text: "Tuesday afternoon is free." }],
        },
      },
      { type: "run.completed" },
    ];
const snapshot = reduceThreadEvents(events);

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <FixtureTranscript
        messages={snapshot.messages}
        running={snapshot.run?.status === "running"}
        showToolActivity={false}
      />
    </I18nProvider>,
  );
});
