import { I18nProvider } from "@lingui/react";
import type { ThreadMessage } from "@rakazo/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { composerDraftKey, subscribeComposerOffer } from "../../src/lib/composer-draft";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import "../../src/styles.css";
import { BOT, FixtureTranscript } from "./thread-fixture";

// A chat where a weather MCP server's tool answered with its app. The spec serves the app's
// HTML (mcp-app-forecast.html) for the artifact read, as the API would.
const params = new URLSearchParams(location.search);
applyResolvedAppearance(params.get("theme") === "dark" ? "dark" : "light");

const createdAt = "2026-11-05T09:00:00.000Z";
const forecast = {
  city: "Lisbon",
  unit: "°C",
  days: [
    { day: "Thu", high: 19, low: 13, sky: "cloud" },
    { day: "Fri", high: 17, low: 12, sky: "rain" },
    { day: "Sat", high: 23, low: 14, sky: "sun" },
    { day: "Sun", high: 22, low: 15, sky: "sun" },
    { day: "Mon", high: 18, low: 13, sky: "cloud" },
  ],
};

const messages: ThreadMessage[] = [
  {
    id: "user-1",
    threadId: "thread-1",
    seq: 1,
    role: "user",
    blocks: [{ kind: "text", text: "What's the weather in Lisbon this week?" }],
    createdAt,
  },
  {
    id: "bot-app",
    threadId: "thread-1",
    seq: 2,
    role: "bot",
    botId: BOT.botId,
    runId: "run-1",
    blocks: [
      {
        kind: "app",
        artifactId: "app-forecast",
        server: "Forecast",
        tool: "get_forecast",
        toolArguments: { city: "Lisbon", days: 5 },
        toolResult: {
          content: [{ type: "text", text: "Lisbon: sunny weekend, 23° on Saturday." }],
          structuredContent: forecast,
        },
      },
    ],
    createdAt,
  },
  {
    id: "bot-reply",
    threadId: "thread-1",
    seq: 3,
    role: "bot",
    botId: BOT.botId,
    runId: "run-1",
    blocks: [
      { kind: "text", text: "A wet Friday, then a sunny weekend. Saturday is the warmest at 23°." },
    ],
    createdAt,
  },
];

/** Stands in for the composer: shows what the app offered to it. */
function Offered() {
  const [text, setText] = useState("");
  useEffect(() => subscribeComposerOffer(composerDraftKey({ botId: BOT.botId }), setText), []);
  return text ? (
    <output data-testid="composer-offer" className="m-4 block text-body">
      {text}
    </output>
  ) : null;
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <FixtureTranscript messages={messages} running={false} showToolActivity={false} />
        <Offered />
      </I18nProvider>
    </QueryClientProvider>,
  );
});
