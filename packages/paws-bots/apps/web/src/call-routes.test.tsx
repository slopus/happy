// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import type * as CoreModule from "@rakazo/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bots: [] as Bot[],
  me: vi.fn(),
  listBots: vi.fn(),
  voiceStatus: vi.fn(),
  endCall: vi.fn(),
  declineIncomingCall: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in parts ? parts.message : String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  defaultBotAvatarValue: () => "",
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));
vi.mock("./lib/call-pickup.js", () => ({ pickUp: () => new Promise(() => undefined) }));
vi.mock("./lib/dictation.js", () => ({
  dictation: { listen: vi.fn(), stop: vi.fn(), subscribe: () => () => undefined },
  usesServerDictation: () => false,
}));
vi.mock("./lib/tts.js", () => ({
  speaker: {
    speak: vi.fn(),
    stop: vi.fn(),
    unlock: vi.fn(),
    isSpeaking: () => false,
    subscribe: () => () => {},
  },
}));
vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({
      isPending: false,
      data: { user: { id: "user-1" } },
      error: null,
      refetch: vi.fn(),
    }),
  },
}));
vi.mock("./lib/bootstrap", () => ({
  getTicketBoardEnabled: () => false,
  subscribeTicketBoardEnabled: () => () => {},
}));
vi.mock("./lib/rpc", () => {
  const client = {
    me: mocks.me,
    bots: { list: mocks.listBots },
    voice: { status: mocks.voiceStatus },
  };
  return {
    clearSpaceSelection: vi.fn(),
    createSpaceRpc: () => client,
    recheckSessionOnUnauthorized: vi.fn(),
    rpc: {
      ...client,
      analytics: { screen: vi.fn(async () => ({ ok: true })) },
      threads: { endCall: mocks.endCall },
      notifications: { declineIncomingCall: mocks.declineIncomingCall },
    },
    rpcForSpace: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./components/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/markdown-link-prompt", () => ({
  MarkdownLinkPrompt: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", () => ({
  ShellPage: () => <Link to="/app/artifacts">Artifacts</Link>,
}));
vi.mock("./pages/Artifacts", () => ({ ArtifactsPage: () => <div>Artifacts page</div> }));

import { App } from "./App";
import { endCall, startCall } from "./lib/call-session";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function find(selector: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(selector);
}

function button(name: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
}

async function settle() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.clearAllMocks();
  mocks.bots = [];
  mocks.me.mockImplementation(async () => ({ phoneCallsEnabled: true }));
  mocks.listBots.mockImplementation(async () => mocks.bots);
  mocks.voiceStatus.mockImplementation(async () => ({ ready: true, transcribe: false }));
  mocks.endCall.mockResolvedValue(undefined);
  mocks.declineIncomingCall.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  endCall();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps an ongoing call in reach after leaving the shell", async () => {
  startCall({ botId: "bot-1", botName: "Test bot" });
  await render("/app/bot-1");
  await act(async () => find('a[href="/app/artifacts"]')?.click());
  await settle();
  expect(container.textContent).toContain("Artifacts page");
  expect(find('[data-testid="call-view"]')).not.toBeNull();
  expect(button("Mute")).not.toBeNull();

  await act(async () => button("Minimize call")?.click());
  expect(find('[data-testid="call-view"]')).toBeNull();
  await act(async () => find('[data-testid="call-return-bar"]')?.click());
  expect(find('[data-testid="call-view"]')).not.toBeNull();

  await act(async () => button("Hang up")?.click());
  await settle();
  expect(find('[data-testid="call-view"]')).toBeNull();
  expect(mocks.endCall).toHaveBeenCalledOnce();
});

it("rings for an incoming call on a page outside the shell", async () => {
  mocks.bots = [
    {
      id: "bot-1",
      name: "Test bot",
      incomingCall: {
        callId: "call-1",
        reason: "Review",
        opening: "Ready?",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    } as Bot,
  ];
  await render("/app/artifacts");
  expect(container.textContent).toContain("Artifacts page");
  expect(find('[data-testid="incoming-call"]')?.getAttribute("aria-label")).toBe(
    "Test bot is calling you",
  );

  const decline = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Decline",
  );
  await act(async () => decline?.click());
  await settle();
  expect(mocks.declineIncomingCall).toHaveBeenCalledWith({ callId: "call-1" });
  expect(find('[data-testid="incoming-call"]')).toBeNull();
});
