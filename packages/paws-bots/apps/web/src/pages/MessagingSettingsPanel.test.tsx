// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const messaging = vi.hoisted(() => ({
  status: vi.fn(),
  installations: {
    list: vi.fn(async () => ({ available: false, installations: [] })),
    start: vi.fn(),
    remove: vi.fn(),
  },
  channels: { list: vi.fn(async () => []), respond: vi.fn(), leave: vi.fn() },
  connections: { list: vi.fn(async () => []), respond: vi.fn(), revoke: vi.fn() },
  identities: { unlink: vi.fn() },
  link: {
    start: vi.fn(async () => ({
      code: "ABCD-2345",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    })),
  },
}));

const api = vi.hoisted(() => ({
  messaging,
  bots: { list: vi.fn(async () => [{ id: "bot-1", name: "Chief" }]) },
  spaces: { list: vi.fn(async () => ({ current: { externalConversations: [] } })) },
}));
vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("./ExternalConversationSettings", () => ({ ExternalConversationSettings: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      children,
      onClick,
      disabled,
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Dialog: Pass,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogTitle: Pass,
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuTrigger: ({ children, disabled }: ComponentProps<"button">) => (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuItem: ({ children, onClick }: ComponentProps<"button">) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { MessagingSettingsPanel } from "./MessagingSettingsPanel";

const identity = {
  id: "mi-1",
  provider: "telegram",
  address: "424242",
  botId: "bot-1",
  botName: "Chief",
};

function statusWith(identities: (typeof identity)[]) {
  return { enabled: true, providers: ["telegram"], openSignup: false, identities };
}

function pendingStatus() {
  let resolve!: (status: ReturnType<typeof statusWith>) => void;
  const promise = new Promise<ReturnType<typeof statusWith>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function renderOverlay() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MessagingSettingsPanel />
      </QueryClientProvider>,
    ),
  );
  // Let query results reach the screen.
  await act(async () => vi.advanceTimersByTimeAsync(0));
}

beforeEach(() => {
  vi.useFakeTimers();
  messaging.installations.list.mockResolvedValue({ available: false, installations: [] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  messaging.status.mockReset();
  messaging.channels.list.mockReset();
  messaging.channels.list.mockResolvedValue([]);
});

function telegramItem() {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Telegram",
  );
}

async function startLink() {
  await renderOverlay();
  await act(async () => telegramItem()?.click());
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
}

it("lists a chat app linked from the chat app without reopening the dialog", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  expect(container.textContent).not.toContain("424242");

  // The code is sent from the chat app; the server now reports the identity.
  messaging.status.mockResolvedValue(statusWith([identity]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
});

it("stops polling once the link code expires", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  const calls = messaging.status.mock.calls.length;

  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(messaging.status.mock.calls.length).toBe(calls);
});

it.each([
  [403, 1],
  [404, 1],
  [503, 4],
])("after a %i status poll, link polls total %i", async (status, polls) => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const calls = messaging.status.mock.calls.length;
  messaging.status.mockRejectedValueOnce(Object.assign(new Error("Refused"), { status }));
  await act(async () => vi.advanceTimersByTimeAsync(12_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls + polls);
});

it("detects a same-address relink to the selected bot", async () => {
  messaging.status.mockResolvedValue(
    statusWith([{ ...identity, botId: "bot-2", botName: "Other" }]),
  );
  await startLink();
  expect(container.textContent).toContain("424242, Other");

  messaging.status.mockResolvedValue(statusWith([identity]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242, Chief");
  expect(container.textContent).not.toContain("424242, Other");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
});

it("ignores links to a different bot", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  messaging.status.mockResolvedValue(statusWith([{ ...identity, botId: "bot-2" }]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
});

it("keeps the detected identity when refreshing other lists fails", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  messaging.status.mockResolvedValue(statusWith([identity]));
  messaging.channels.list.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  const calls = messaging.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("waits for a pending poll to settle before scheduling another", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = pendingStatus();
  messaging.status.mockReturnValueOnce(pending.promise);
  const calls = messaging.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(9_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 1);

  await act(async () => pending.resolve(statusWith([])));
  await act(async () => vi.advanceTimersByTimeAsync(2_999));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 2);
});

it("ignores a previous code's pending response after issuing a new code", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = pendingStatus();
  messaging.status.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  await act(async () => telegramItem()?.click());
  const calls = messaging.status.mock.calls.length;
  await act(async () => pending.resolve(statusWith([identity])));

  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
  expect(container.textContent).not.toContain("424242");
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("ignores a pending response after expiry", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = pendingStatus();
  messaging.status.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  const calls = messaging.status.mock.calls.length;
  await act(async () => pending.resolve(statusWith([identity])));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  expect(container.textContent).not.toContain("424242");
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("connects Slack to the default bot through workspace authorization", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({ available: true, installations: [] });
  const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as never);
  messaging.installations.start.mockResolvedValue({ url: "https://slack.example.test/authorize" });
  try {
    await renderOverlay();
    const buttons = [...container.querySelectorAll("button")];
    expect(container.textContent).toContain("Chat with your bot from Slack.");
    expect(buttons.filter((button) => button.textContent === "Connect")).toHaveLength(1);
    expect(
      buttons.some((button) =>
        ["Slack", "Connect a chat app", "Link DMs"].includes(button.textContent ?? ""),
      ),
    ).toBe(false);
    expect(container.querySelector("select")).toBeNull();
    await act(async () => buttons.find((button) => button.textContent === "Connect")!.click());
    expect(messaging.installations.start).toHaveBeenCalledWith({});
    expect(messaging.link.start).not.toHaveBeenCalled();
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("https://slack.example.test/authorize");
  } finally {
    open.mockRestore();
  }
});

it("shows Slack as its own row, apart from apps linked with a code", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack", "telegram"] });
  messaging.installations.list.mockResolvedValue({ available: true, installations: [] });
  await renderOverlay();
  const items = [...container.querySelectorAll("button")].map((button) => button.textContent);
  expect(items).toContain("Connect");
  expect(items).toContain("Telegram");
  expect(items).not.toContain("Slack");
});

it("keeps code linking for legacy Slack deployments", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  await renderOverlay();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Slack")!
      .click(),
  );
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(messaging.installations.start).not.toHaveBeenCalled();
});

it("links DMs to the bot that answers in the workspace", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([identity]),
    providers: ["slack", "telegram"],
  });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [
      { id: "install-1", provider: "slack", workspaceName: "Example workspace", botId: "bot-2" },
    ],
  } as never);
  api.bots.list.mockResolvedValueOnce([
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ]);
  await renderOverlay();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link DMs")!
      .click(),
  );
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-2" });
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
});

async function reopen() {
  act(() => root.unmount());
  await client.invalidateQueries();
  root = createRoot(container);
}

it("reopens with cached chat apps and refreshes them in the background", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  await renderOverlay();
  expect(container.textContent).toContain("424242");
  await reopen();

  const pending = pendingStatus();
  messaging.status.mockReturnValueOnce(pending.promise);
  await renderOverlay();
  // Painted from the cache while the refresh is still out.
  expect(container.textContent).toContain("424242");
  await act(async () => pending.resolve(statusWith([])));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(container.textContent).not.toContain("424242");
});

it("says when reopening could not refresh, while still showing cached chat apps", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  await renderOverlay();
  await reopen();

  messaging.status.mockRejectedValue(new Error("offline"));
  await renderOverlay();
  expect(container.textContent).toContain("Couldn't load messaging settings");
  expect(container.textContent).toContain("424242");
});

it("keeps an unlink when an older status read lands after it", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  await renderOverlay();
  await reopen();

  const older = pendingStatus();
  messaging.status.mockReturnValueOnce(older.promise).mockResolvedValue(statusWith([]));
  messaging.identities.unlink.mockResolvedValue({ ok: true });
  await renderOverlay();
  const unlink = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Unlink"),
  );
  await act(async () => unlink?.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(container.textContent).not.toContain("424242");
  // The read sent before the unlink still reports the identity; it must not come back.
  await act(async () => older.resolve(statusWith([identity])));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(container.textContent).not.toContain("424242");
});

it("keeps a removed Slack workspace gone when an older read lands after it", async () => {
  const workspace = {
    available: true,
    installations: [
      {
        id: "inst-1",
        provider: "slack",
        workspaceName: "Acme HQ",
        botId: "bot-1",
        botName: "Chief",
      },
    ],
  };
  messaging.status.mockResolvedValue(statusWith([]));
  messaging.installations.list.mockResolvedValue(workspace as never);
  await renderOverlay();
  // The bot's name comes with the workspace: it may live in another space.
  expect(container.textContent).toContain("Acme HQ, Chief");
  await reopen();

  let answerOlder!: (value: typeof workspace) => void;
  messaging.installations.list
    .mockReturnValueOnce(new Promise((done) => (answerOlder = done)) as never)
    .mockResolvedValue({ available: true, installations: [] });
  messaging.installations.remove.mockResolvedValue({ ok: true });
  await renderOverlay();
  const remove = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect",
  );
  if (!remove) throw new Error("Missing remove button");
  await act(async () => remove.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(container.textContent).not.toContain("Acme HQ");
  await act(async () => answerOlder(workspace));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(container.textContent).not.toContain("Acme HQ");
});

it("says which line to send the code to when the app has one", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([]),
    providers: ["sendblue"],
    addresses: { sendblue: "+15550001111" },
  });
  await renderOverlay();
  const item = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "iMessage",
  );
  await act(async () => item?.click());
  expect(container.querySelector('[data-testid="messaging-link-code"]')?.textContent).toContain(
    "+15550001111",
  );
});

it("keeps DM linking available for each connected workspace", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([{ ...identity, provider: "slack" }]),
    providers: ["slack"],
  });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [
      { id: "install-1", provider: "slack", workspaceName: "First workspace", botId: "bot-1" },
      { id: "install-2", provider: "slack", workspaceName: "Second workspace", botId: "bot-1" },
    ],
  } as never);
  await renderOverlay();
  expect(
    [...container.querySelectorAll("button")].filter((button) => button.textContent === "Link DMs"),
  ).toHaveLength(2);
});

it("lets members link personal DMs without owning the workspace connection", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [],
    personalLinkAvailable: true,
  } as never);
  await renderOverlay();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link DMs")!
      .click(),
  );
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(messaging.installations.start).not.toHaveBeenCalled();
});

it("keeps other apps usable and withholds Slack when its setup method cannot load", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack", "telegram"] });
  messaging.installations.list.mockRejectedValue(new Error("unavailable"));
  await renderOverlay();
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.find((button) => button.textContent === "Connect a chat app")!.disabled).toBe(
    false,
  );
  expect(buttons.some((button) => button.textContent === "Slack")).toBe(false);
  await act(async () => telegramItem()!.click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
});

it("lets a member choose which bot their DMs link to in a teammate's workspace", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [],
    personalLinkAvailable: true,
  } as never);
  api.bots.list.mockResolvedValueOnce([
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ]);
  await renderOverlay();
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "bot-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link DMs")!
      .click(),
  );
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-2" });
});

it("keeps a teammate's DM link next to the user's own workspace elsewhere", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [
      {
        id: "install-1",
        provider: "slack",
        workspaceName: "Home",
        botId: "bot-2",
        botName: "Team",
      },
    ],
    personalLinkAvailable: true,
  } as never);
  await renderOverlay();
  const links = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Link DMs",
  );
  expect(links).toHaveLength(2);
  await act(async () => links[1]!.click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
});
