// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import type * as CoreModule from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  answerCall: vi.fn(),
  endCall: vi.fn(),
  send: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
  speak: vi.fn(),
  reload: vi.fn(),
  assign: vi.fn(),
  pickUp: vi.fn(),
  stopSpeech: vi.fn(),
}));

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
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
vi.mock("./auth", () => ({ authClient: { signOut: mocks.signOut } }));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));
vi.mock("./call-pickup.js", () => ({ pickUp: mocks.pickUp }));
vi.mock("./dictation.js", () => ({
  dictation: { listen: mocks.listen, stop: mocks.stop, subscribe: () => () => undefined },
  usesServerDictation: () => false,
}));
vi.mock("./tts.js", () => ({
  speaker: {
    speak: mocks.speak,
    stop: mocks.stopSpeech,
    unlock: vi.fn(),
    isSpeaking: () => false,
    subscribe: () => () => undefined,
  },
}));
vi.mock("./rpc", () => ({
  clearSpaceSelection: vi.fn(),
  recheckSessionOnUnauthorized: vi.fn(),
  rpc: {
    threads: { answerCall: mocks.answerCall, endCall: mocks.endCall, send: mocks.send },
  },
  selectedSpaceId: () => "space-1",
}));

/** Listeners a previous test's module copy left on the shared window. */
let listeners: Array<[string, EventListenerOrEventListenerObject]> = [];

// Leaving the page is final, so every test loads fresh modules, as a new page would.
async function load() {
  vi.resetModules();
  return {
    calls: await import("./call-session"),
    signOut: (await import("./sign-out")).signOut,
    IncomingCall: (await import("../components/call/IncomingCall")).IncomingCall,
    channel: (await import("better-auth/client")).getGlobalBroadcastChannel(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("better-auth:broadcast-channel")];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (listener) listeners.push([type, listener]);
    add(type, listener, options);
  });
  vi.stubGlobal("location", { reload: mocks.reload, assign: mocks.assign });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.endCall.mockResolvedValue({ ok: true });
  mocks.listen.mockResolvedValue(undefined);
  mocks.speak.mockResolvedValue(undefined);
  mocks.pickUp.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const [type, listener] of listeners) window.removeEventListener(type, listener);
  listeners = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  localStorage.clear();
});

async function inCall(calls: Awaited<ReturnType<typeof load>>["calls"]) {
  calls.syncCallIdentity("user-a");
  calls.startCall({ botId: "bot-a", botName: "Ada" });
  await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
  mocks.stop.mockClear();
}

/** Starts a call with a spoken message still being sent. */
async function inCallWithPendingSend(calls: Awaited<ReturnType<typeof load>>["calls"]) {
  let finishSend!: () => void;
  mocks.send.mockReturnValue(
    new Promise((resolve) => {
      finishSend = () => resolve({ runId: "run-1", taskId: "task-1" });
    }),
  );
  await inCall(calls);
  void mocks.listen.mock.calls[0]?.[0].onFinal?.("book the flight");
  expect(mocks.send).toHaveBeenCalledOnce();
  return () => finishSend();
}

function storageEvent(key: string, newValue: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

function expectEndedHereOnly(calls: Awaited<ReturnType<typeof load>>["calls"]) {
  expect(calls.getSnapshot()).toBeNull();
  expect(mocks.stop).toHaveBeenCalledWith("cancel");
  expect(mocks.endCall).not.toHaveBeenCalled();
}

it("keeps embedded account mounts out of the shared cookie signout channel", async () => {
  vi.stubEnv("PAWS_EMBEDDED", "true");
  const first = await load();
  const subscribe = vi.spyOn(first.channel, "subscribe");
  first.calls.syncCallIdentity("embedded-user-a");
  (await import("../paws/runtime")).disconnect();
  const second = await load();
  expect(second.channel).toBe(first.channel);
  second.calls.syncCallIdentity("embedded-user-b");
  const stopListening = second.channel.setup();
  try {
    storageEvent("better-auth.message", JSON.stringify({ event: "session", data: { trigger: "signout" },
      clientId: "another-mount", timestamp: Date.now() }));
    expect(subscribe).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  } finally { stopListening(); }
});

it("aborts a ringing call on host disposal and ignores its late pickup", async () => {
  let finishPickup!: () => void;
  let signal!: AbortSignal;
  mocks.pickUp.mockImplementationOnce((current: AbortSignal) => {
    signal = current;
    return new Promise<void>(resolve => { finishPickup = resolve; });
  });
  const { calls } = await load();
  calls.syncCallIdentity("user-a");
  calls.startCall({ botId: "bot-a", botName: "Ada" });
  expect(signal.aborted).toBe(false);
  mocks.stop.mockClear(); mocks.stopSpeech.mockClear();
  calls.disposeCallSession();
  expect(signal.aborted).toBe(true);
  expect(calls.getSnapshot()).toBeNull();
  expect(mocks.stop).toHaveBeenCalledWith("cancel");
  expect(mocks.stopSpeech).toHaveBeenCalledOnce();
  finishPickup(); await Promise.resolve();
  expect(mocks.listen).not.toHaveBeenCalled();
  expect(mocks.endCall).not.toHaveBeenCalled();
  calls.startCall({ botId: "late-bot", botName: "Late" });
  expect(calls.getSnapshot()).toBeNull();
});

it("stops an active microphone and cancels a pending logout when the host leaves", async () => {
  const { calls, signOut } = await load();
  const finishSend = await inCallWithPendingSend(calls);
  const signedOut = signOut("/");
  await Promise.resolve();
  mocks.stop.mockClear(); mocks.stopSpeech.mockClear();
  calls.disposeCallSession();
  expect(calls.getSnapshot()).toBeNull();
  expect(mocks.stop).toHaveBeenCalledWith("cancel");
  expect(mocks.stopSpeech).toHaveBeenCalledOnce();
  finishSend(); await signedOut;
  expect(mocks.endCall).not.toHaveBeenCalled();
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(mocks.reload).not.toHaveBeenCalled();
  expect(mocks.assign).not.toHaveBeenCalled();
});

it("ends the call and stops the mic on sign-out, hanging up first, then leaves the page", async () => {
  const { calls, signOut } = await load();
  await inCall(calls);

  await signOut("/");
  expect(calls.getSnapshot()).toBeNull();
  expect(mocks.stop).toHaveBeenCalledWith("cancel");
  expect(mocks.endCall).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-a" }));
  expect(mocks.endCall.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.signOut.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mocks.assign).toHaveBeenCalledWith("/");
  expect(localStorage.getItem(calls.SIGNED_IN_USER_KEY)).toBeNull();
});

it("waits for a spoken send, then hangs up before signing out", async () => {
  const { calls, signOut } = await load();
  const finishSend = await inCallWithPendingSend(calls);
  const signedOut = signOut("/");
  await Promise.resolve();
  expect(calls.getSnapshot()).toBeNull();
  expect(mocks.signOut).not.toHaveBeenCalled();

  finishSend();
  await signedOut;
  expect(mocks.endCall).toHaveBeenCalledOnce();
  expect(mocks.endCall.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.signOut.mock.invocationCallOrder[0] ?? 0,
  );
});

it.each([
  ["succeeds", { error: null }, "assign"],
  ["fails", { error: { status: 503 } }, "reload"],
] as const)(
  "never hangs up after the wait runs out, and leaves the page when logout %s",
  async (_outcome, result, leave) => {
    const { calls, signOut } = await load();
    const finishSend = await inCallWithPendingSend(calls);
    mocks.signOut.mockResolvedValue(result);
    vi.useFakeTimers();
    const signedOut = signOut("/");
    await vi.advanceTimersByTimeAsync(calls.SIGN_OUT_HANG_UP_MS);
    await signedOut;
    expect(mocks[leave]).toHaveBeenCalledOnce();
    // Another window may have installed someone else's cookie by now.
    finishSend();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.endCall).not.toHaveBeenCalled();
  },
);

it("does not sign out with another user's cookie when the account changes during the wait", async () => {
  const { calls, signOut } = await load();
  const finishSend = await inCallWithPendingSend(calls);
  const signedOut = signOut("/");
  await Promise.resolve();
  // Another tab signs in as someone else while this tab waits to hang up.
  storageEvent(calls.SIGNED_IN_USER_KEY, "user-b");
  finishSend();
  await signedOut;
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(mocks.reload).toHaveBeenCalledOnce();
  expect(mocks.assign).not.toHaveBeenCalled();
});

it("ends the call here and reloads when another tab signs out", async () => {
  const { calls, channel } = await load();
  const stopListening = channel.setup();
  try {
    await inCall(calls);
    storageEvent(
      "better-auth.message",
      JSON.stringify({ event: "session", data: { trigger: "signout" } }),
    );
    expectEndedHereOnly(calls);
    expect(mocks.reload).toHaveBeenCalledOnce();
  } finally {
    stopListening();
  }
});

it("reloads when another tab confirms another user, not the same one", async () => {
  const { calls } = await load();
  calls.syncCallIdentity("user-a");
  expect(localStorage.getItem(calls.SIGNED_IN_USER_KEY)).toBe("user-a");
  storageEvent(calls.SIGNED_IN_USER_KEY, "user-a");
  expect(mocks.reload).not.toHaveBeenCalled();

  storageEvent(calls.SIGNED_IN_USER_KEY, "user-b");
  expect(mocks.reload).toHaveBeenCalledOnce();
});

it.each([null, "user-b"])(
  "ends the call here and reloads when this tab's user becomes %s",
  async (next) => {
    const { calls } = await load();
    await inCall(calls);
    calls.syncCallIdentity("user-a");
    expect(mocks.reload).not.toHaveBeenCalled();

    calls.syncCallIdentity(next);
    expectEndedHereOnly(calls);
    expect(mocks.reload).toHaveBeenCalledOnce();
  },
);

it.each([
  ["another tab switches the account", () => storageEvent("rakazo.signedInUser", "user-b")],
  ["this tab signs out", (signOut: (to: string) => Promise<void>) => signOut("/")],
])(
  "reloads with an answer pending when %s, and the late answer starts no call",
  async (_name, change) => {
    const { calls, signOut, IncomingCall } = await load();
    calls.syncCallIdentity("user-a");
    let deliver: (value: { opening: string; reason: string }) => void = () => undefined;
    mocks.answerCall.mockReturnValue(
      new Promise((resolve) => {
        deliver = resolve;
      }),
    );
    const bot = {
      id: "bot-1",
      name: "Test bot",
      incomingCall: {
        callId: "call-1",
        reason: "Review",
        opening: "Ready?",
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    } as Bot;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<IncomingCall bots={[bot]} onAnswered={() => undefined} />));
      act(() =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Answer")!
          .click(),
      );
      expect(mocks.answerCall).toHaveBeenCalledOnce();

      await change(signOut);
      expect(mocks.reload.mock.calls.length + mocks.assign.mock.calls.length).toBe(1);
      // The page may still run briefly before it unloads.
      await act(async () => deliver({ opening: "Ready?", reason: "Review" }));
      expect(calls.getSnapshot()).toBeNull();
      expect(mocks.speak).not.toHaveBeenCalled();
      expect(mocks.listen).not.toHaveBeenCalled();
      expect(mocks.endCall).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  },
);
