import { I18nProvider } from "@lingui/react";
import type { Bot, Me, ModelCatalogEntry } from "@rakazo/contracts";
import { defaultCronPreset } from "@rakazo/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AskCard } from "../../src/components/AskCard";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import type { RoutineDraftState } from "../../src/lib/routine-draft";
import { rpc } from "../../src/lib/rpc";
import { RoutineEditor } from "../../src/pages/RoutineEditor";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import { BotSettings } from "../../src/pages/shell/bot-panel";
import { CreateBotDialog } from "../../src/pages/shell/create-bot-dialog";
import "../../src/styles.css";

const demoRpc: Record<string, unknown> = {
  "voice/voices": [],
  "models/credentials": [
    {
      id: "cred-demo",
      provider: "openai",
      label: "OpenAI",
      hasKey: true,
      isDefault: true,
      modelId: "gpt-4.1",
    },
  ],
  "models/list": [
    {
      provider: "openai",
      providerName: "OpenAI",
      id: "gpt-4.1",
      label: "GPT-4.1",
      billing: "",
    },
    {
      provider: "openai",
      providerName: "OpenAI",
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      billing: "",
    },
  ],
  me: null,
  "scratchpad/list": [],
  "memory/list": [],
  "agentSkills/list": [],
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("/rpc/")) {
    const path = new URL(url, location.origin).pathname.replace(/^\/rpc\//, "");
    const body = path in demoRpc ? demoRpc[path] : [];
    return new Response(JSON.stringify({ json: body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

function inboxBot(): Bot {
  return {
    id: "bot-inbox",
    spaceId: "space-demo",
    name: "Inbox",
    title: "Sorts the demo inbox",
    description: "Files routine mail for ada@example.test and leaves the rest for review.",
    instructions: "File routine mail. Ask before sending anything.",
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-demo",
    preview: "",
    status: "idle",
    computerMode: "team",
    updatedAt: "2026-10-07T00:00:00.000Z",
    createdAt: "2026-10-07T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    replyMode: "chat",
    modelProvider: "openai",
    modelId: "gpt-4.1",
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
    runErrorId: null,
    fleetManagement: true,
    disabledBuiltinTools: [],
  };
}

function CreateShot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let frame = 0;
    // The dialog renders in a portal, so wait for it before filling it in.
    const fillWhenOpen = () => {
      const name = document.querySelector<HTMLInputElement>('input[placeholder="Name your Bot"]');
      if (!name) {
        frame = requestAnimationFrame(fillWhenOpen);
        return;
      }
      fill(name, "Inbox");
      document.querySelector<HTMLButtonElement>('button[aria-label="Shape 1"]')?.click();
      document.querySelector<HTMLButtonElement>('button[aria-label="Color #A97EFE"]')?.click();
      setReady(true);
    };
    fillWhenOpen();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <main data-ready={ready ? "true" : "false"} className="min-h-screen bg-background">
      <CreateBotDialog
        avatarSet="organic"
        onCreate={async () => undefined}
        onCancel={() => undefined}
      />
    </main>
  );
}

function fill(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function ModelShot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <main
      data-ready={ready ? "true" : "false"}
      className="mx-auto max-w-[720px] bg-background p-8 text-foreground"
    >
      <BotSettings
        bot={inboxBot()}
        memoryProviderConfigured={false}
        onSkillsChange={() => undefined}
        onSave={async () => undefined}
        onExport={async () => undefined}
        onClear={() => undefined}
      />
    </main>
  );
}

function RoutineShot() {
  const preset = { ...defaultCronPreset(), freq: "Weekdays" as const, time: "8:00 AM" };
  const [draft, setDraft] = useState<RoutineDraftState>({
    name: "Weekday inbox",
    prompt: "Read the demo inbox, file the routine mail, and list anything that needs a person.",
    schedules: [preset],
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
    active: true,
    runAtLocal: "",
    modelKey: "",
    thinkingLevel: "",
    watch: null,
  });
  return (
    <main data-ready="true" className="mx-auto max-w-[760px] bg-background p-8 text-foreground">
      <RoutineEditor
        bot={{ id: "bot-demo", name: "Scout" }}
        draft={draft}
        onChange={setDraft}
        editing={null}
        timezone="UTC"
        webhook={{ path: "/hooks/demo", secret: null, configured: false }}
        githubPath=""
        messageProviders={[]}
        saving={false}
        running={false}
        error={null}
        onBack={() => undefined}
        onClose={() => undefined}
        onSave={() => undefined}
        onTestRun={() => undefined}
        onDelete={() => undefined}
        onEnsureWebhook={async () => undefined}
        onRevealWebhook={async () => undefined}
        onHideWebhook={() => undefined}
      />
    </main>
  );
}

function ApprovalShot() {
  return (
    <main data-ready="true" className="mx-auto max-w-[760px] bg-background p-8 text-foreground">
      <AskCard
        canAnswer
        canDismiss={false}
        onDismiss={async () => undefined}
        onAnswer={async () => undefined}
        block={{
          kind: "ask",
          approvalEffectId: "effect-demo",
          text: "Review before sending a reply from the demo inbox.",
          detail: "To: ada@example.test\nSubject: Re: Invoice 1042\n\nThanks, I will take a look.",
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow this tool" },
            { id: "deny", label: "Deny" },
          ],
        }}
      />
    </main>
  );
}

const subscriptionMe: Me = {
  ticketBoardEnabled: false,
  navLinks: [],
  phoneCallsEnabled: false,
  userId: "user-demo",
  email: "ada@example.test",
  name: "Ada",
  spaceId: "space-demo",
  isDeploymentOwner: true,
  isAdmin: false,
  needsModel: false,
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-5-5",
  hostCredentialProvider: null,
  hostCredentialSource: null,
  computerHost: "docker",
  canChooseHostComputer: true,
  sandboxProvider: "docker",
  mcpStdioEnabled: false,
  avatarStyle: "organic",
  billingEnabled: false,
};

const subscriptionCatalog: ModelCatalogEntry[] = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    billing: "",
    auth: "both",
    oauthLabel: "Sign in with Claude",
    authHint: "Claude Pro/Max / key",
    subscription: true,
    signIn: "auth-url",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "openai-codex",
    providerName: "OpenAI Codex",
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    billing:
      "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.",
    auth: "oauth",
    oauthLabel: "Sign in with ChatGPT",
    authHint: "ChatGPT Plus/Pro",
    subscription: true,
    signIn: "device-code",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "xai",
    providerName: "xAI",
    id: "grok-4.6",
    label: "grok-4.6",
    billing: "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.",
    auth: "both",
    oauthLabel: "Sign in with SuperGrok or X Premium",
    authHint: "SuperGrok / key",
    subscription: true,
    signIn: "device-code",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  },
];

function SubscriptionShot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const text = document.body.textContent ?? "";
      if (text.includes("Sign in with Claude") && text.includes("Claude Sonnet 5.5")) {
        setReady(true);
        window.clearInterval(timer);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <main
      data-ready={ready ? "true" : "false"}
      className="min-h-screen bg-background text-foreground"
    >
      <SettingsOverlay
        shellRpc={rpc}
        email="ada@example.test"
        name="Ada"
        section="models"
        onSectionChange={() => undefined}
        memoryConfig={null}
        onMemoryConfigChange={() => undefined}
        onUsageOpen={() => undefined}
        timezone="UTC"
        onTimezoneChange={async () => undefined}
        onClose={() => undefined}
      />
    </main>
  );
}

const view = new URLSearchParams(location.search).get("view") ?? "create";

if (view === "subscription") {
  demoRpc.me = subscriptionMe;
  demoRpc["models/list"] = subscriptionCatalog;
  demoRpc["models/credentials"] = [];
  demoRpc["models/backups"] = [];
}

void bootstrapI18n("en").then(() => {
  const shot =
    view === "model" ? (
      <ModelShot />
    ) : view === "routine" ? (
      <RoutineShot />
    ) : view === "approval" ? (
      <ApprovalShot />
    ) : view === "subscription" ? (
      <SubscriptionShot />
    ) : (
      <CreateShot />
    );
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>{shot}</I18nProvider>
    </QueryClientProvider>,
  );
});
