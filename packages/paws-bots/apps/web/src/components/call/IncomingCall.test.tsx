// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isLeavingSession, startCall } from "../../lib/call-session";
import { rpc } from "../../lib/rpc";
import { IncomingCall } from "./IncomingCall";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in parts ? parts.message : String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  defaultBotAvatarValue: () => "",
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../lib/call-session", () => ({
  isLeavingSession: vi.fn(() => false),
  prepareCallAudio: vi.fn(),
  startCall: vi.fn(),
  useCallSession: () => null,
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    threads: { answerCall: vi.fn(), endCall: vi.fn() },
    notifications: { declineIncomingCall: vi.fn() },
  },
  selectedSpaceId: () => "space-1",
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const close = vi.fn();
const notify = vi.fn();
let visibility: DocumentVisibilityState = "hidden";
const start = Date.parse("2026-10-15T00:00:00Z");
function bot(callId: string, expiresAt: number): Bot {
  return {
    id: "bot-1",
    name: "Test bot",
    incomingCall: {
      callId,
      reason: "Review",
      opening: "Ready?",
      expiresAt: new Date(expiresAt).toISOString(),
    },
  } as Bot;
}
/** Below md the call view covers the app. */
function viewport(width: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("matchMedia", () => ({
    matches: width < 768,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}
/** Base UI moves focus a microtask and an animation frame after a change. */
async function flushFocus() {
  await act(() => vi.advanceTimersByTimeAsync(50));
}
function render(bots: Bot[]) {
  act(() => root.render(<IncomingCall bots={bots} onAnswered={vi.fn()} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport(1024);
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      close = close;
      constructor(...args: unknown[]) {
        notify(...args);
      }
    },
  );
  visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.clearAllMocks();
  vi.mocked(rpc.threads.answerCall).mockReset();
  vi.mocked(rpc.notifications.declineIncomingCall).mockReset();
  vi.mocked(rpc.threads.endCall).mockReset();
  vi.mocked(isLeavingSession).mockReturnValue(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("uses current time after idle and rejects already expired calls", () => {
  render([]);
  vi.setSystemTime(start + 300_000);
  render([bot("old", start + 45_000)]);
  expect(container.querySelector('[data-testid="incoming-call"]')).toBeNull();
  render([bot("new", start + 315_000)]);
  expect(container.querySelector('[data-testid="incoming-call"]')).not.toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[data-testid="incoming-call"]')).not.toBeNull();
});

it("keeps the notification across roster refreshes and closes it on remote answer", () => {
  render([bot("call-1", start + 45_000)]);
  render([bot("call-1", start + 45_000)]);
  expect(notify).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  render([]);
  expect(close).toHaveBeenCalledOnce();
});

it("notifies when a visible call's tab becomes hidden", () => {
  visibility = "visible";
  render([bot("call-1", start + 45_000)]);
  expect(notify).not.toHaveBeenCalled();
  visibility = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(notify).toHaveBeenCalledOnce();
});

it("keeps the notification alive when the bot is renamed", () => {
  render([bot("call-1", start + 45_000)]);
  const renamed = bot("call-1", start + 45_000);
  renamed.name = "Renamed bot";
  render([renamed]);
  expect(container.textContent).toContain("Renamed bot");
  expect(notify).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it("closes the notification on expiry", () => {
  render([bot("call-1", start + 1000)]);
  act(() => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[data-testid="incoming-call"]')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  ["Answer", "CONFLICT"],
  ["Answer", "SERVICE_UNAVAILABLE"],
  ["Decline", "CONFLICT"],
  ["Decline", "SERVICE_UNAVAILABLE"],
])("handles a %s %s without losing transient retries", async (action, code) => {
  vi.mocked(rpc.threads.answerCall).mockRejectedValueOnce({ code });
  vi.mocked(rpc.notifications.declineIncomingCall).mockRejectedValueOnce({ code });
  render([bot("call-1", start + 45_000)]);
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === action)!
      .click();
  });
  expect(Boolean(container.querySelector('[data-testid="incoming-call"]'))).toBe(
    code !== "CONFLICT",
  );
  expect(close).toHaveBeenCalledTimes(code === "CONFLICT" ? 1 : 0);
});

it.each(["Answer", "Decline"])("keeps a failed %s retryable", async (action) => {
  vi.mocked(rpc.threads.answerCall).mockRejectedValue(new Error("Connection failed"));
  vi.mocked(rpc.notifications.declineIncomingCall).mockRejectedValue(
    new Error("Connection failed"),
  );
  render([bot("call-1", start + 45_000)]);
  const button = () =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === action)!;
  await act(async () => button().click());
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection failed");
  expect(button().disabled).toBe(false);
});

it.each(["Answer", "Decline"])(
  "sends no %s while the page is leaving its session",
  async (action) => {
    // Another tab switched accounts and this page is reloading: its cookie is no longer the caller's.
    vi.mocked(isLeavingSession).mockReturnValue(true);
    render([bot("call-1", start + 45_000)]);
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === action,
    )!;
    await act(async () => button.click());
    expect(rpc.threads.answerCall).not.toHaveBeenCalled();
    expect(rpc.notifications.declineIncomingCall).not.toHaveBeenCalled();
  },
);

it("keeps private call content out of notifications", () => {
  const caller = bot("call-1", start + 45_000);
  caller.incomingCall!.reason = "Private reason";
  caller.incomingCall!.opening = "Private opening";
  render([caller]);
  expect(notify).toHaveBeenCalledOnce();
  expect(JSON.stringify(notify.mock.calls)).not.toContain("Private");
});

it("hangs up an answer that lands after the call view is gone", async () => {
  let deliver: (value: { opening: string; reason: string }) => void = () => undefined;
  vi.mocked(rpc.threads.answerCall).mockReturnValue(
    new Promise((resolve) => {
      deliver = resolve;
    }),
  );
  vi.mocked(rpc.threads.endCall).mockResolvedValue({ ok: true });
  const onAnswered = vi.fn();
  act(() =>
    root.render(<IncomingCall bots={[bot("call-1", start + 45_000)]} onAnswered={onAnswered} />),
  );
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Answer")!
      .click(),
  );
  act(() => root.render(null));
  await act(async () => deliver({ opening: "Ready?", reason: "Review" }));
  expect(startCall).not.toHaveBeenCalled();
  expect(onAnswered).not.toHaveBeenCalled();
  expect(rpc.threads.endCall).toHaveBeenCalledWith(
    { botId: "bot-1", callId: "call-1" },
    { context: { spaceId: "space-1" } },
  );
});

it("sends nothing for an answer that lands while the page reloads for another session", async () => {
  let deliver: (value: { opening: string; reason: string }) => void = () => undefined;
  vi.mocked(rpc.threads.answerCall).mockReturnValue(
    new Promise((resolve) => {
      deliver = resolve;
    }),
  );
  const onAnswered = vi.fn();
  act(() =>
    root.render(<IncomingCall bots={[bot("call-1", start + 45_000)]} onAnswered={onAnswered} />),
  );
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Answer")!
      .click(),
  );
  act(() => root.render(null));
  // Another tab switched accounts: a hang-up now would carry the other user's cookie.
  vi.mocked(isLeavingSession).mockReturnValue(true);
  await act(async () => deliver({ opening: "Ready?", reason: "Review" }));
  expect(rpc.threads.endCall).not.toHaveBeenCalled();
  expect(startCall).not.toHaveBeenCalled();
  expect(onAnswered).not.toHaveBeenCalled();
});

it("hangs up an answer that lands while a lazy route hides the call view", async () => {
  let deliver: (value: { opening: string; reason: string }) => void = () => undefined;
  vi.mocked(rpc.threads.answerCall).mockReturnValue(
    new Promise((resolve) => {
      deliver = resolve;
    }),
  );
  vi.mocked(rpc.threads.endCall).mockResolvedValue({ ok: true });
  const onAnswered = vi.fn();
  const pendingRoute = new Promise<never>(() => undefined);
  function Route({ loading }: { loading: boolean }) {
    if (loading) throw pendingRoute;
    return null;
  }
  const view = (loading: boolean) => (
    <Suspense fallback={null}>
      <IncomingCall bots={[bot("call-1", start + 45_000)]} onAnswered={onAnswered} />
      <Route loading={loading} />
    </Suspense>
  );
  act(() => root.render(view(false)));
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Answer")!
      .click(),
  );
  // Navigating to a lazy page hides the shell without unmounting it.
  act(() => root.render(view(true)));
  await act(async () => deliver({ opening: "Ready?", reason: "Review" }));
  expect(startCall).not.toHaveBeenCalled();
  expect(onAnswered).not.toHaveBeenCalled();
  expect(rpc.threads.endCall).toHaveBeenCalledWith(
    { botId: "bot-1", callId: "call-1" },
    { context: { spaceId: "space-1" } },
  );
});

it("takes focus on a phone screen, shuts out the app behind it, and gives focus back", async () => {
  viewport(375);
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  render([bot("call-1", start + 45_000)]);
  await flushFocus();
  const view = document.querySelector('[role="alertdialog"]');
  expect(view?.contains(document.activeElement)).toBe(true);
  expect(composer.closest('[aria-hidden="true"]')).not.toBeNull();
  render([]);
  await flushFocus();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
  composer.remove();
});

it("leaves focus in the app beside the desktop card", async () => {
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  render([bot("call-1", start + 45_000)]);
  await flushFocus();
  expect(document.activeElement).toBe(composer);
  expect(composer.closest('[aria-hidden="true"]')).toBeNull();
  composer.remove();
});
