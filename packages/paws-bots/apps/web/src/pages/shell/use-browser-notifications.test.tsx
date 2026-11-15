// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { Bot, ChatAlert } from "@rakazo/contracts";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "@rakazo/core";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import { useBrowserNotifications } from "./use-browser-notifications";

type Frame = { type: "alert" | "roster" | "heartbeat"; alert?: ChatAlert };

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

let streams: Array<{ push: (frame: Frame) => void; fail: (error: unknown) => void }>;
let signals: AbortSignal[];
let focused: boolean;
let visible: boolean;
let openChat: ReturnType<typeof vi.fn<(chat: Pick<ChatAlert, "botId" | "groupId">) => void>>;
let root: Root;
let hook: ReturnType<typeof useBrowserNotifications>;

function stream(): AsyncIterable<Frame> {
  const queue: Frame[] = [];
  let failure: unknown;
  let wake: (() => void) | undefined;
  streams.push({
    push: (frame) => {
      queue.push(frame);
      wake?.();
    },
    fail: (error) => {
      failure = error;
      wake?.();
    },
  });
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (failure) throw failure;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

const rpc = {
  notifications: {
    subscribe: (_input: undefined, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return Promise.resolve(stream());
    },
  },
} as unknown as Pick<RpcClient, "notifications">;

const noBots: Bot[] = [];
const bots = [{ id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot];
const groups: Array<{ id: string; snoozedUntil?: string | null }> = [{ id: "group-g" }];
const roster = { changed: vi.fn(), lost: vi.fn() };

function Harness({ botId, groupId }: { botId?: string; groupId?: string }) {
  hook = useBrowserNotifications(
    noBots,
    { current: bots },
    {
      rpc,
      activeBotId: { current: botId },
      activeGroupId: { current: groupId },
      openChat,
      meId: "user-1",
      groupsRef: { current: groups },
      roster,
    },
  );
  return null;
}

function reply(id: string, blocks: Array<Record<string, unknown>>, threadId = "thread-b") {
  return {
    id,
    type: "thread.message.created" as const,
    threadId,
    seq: 5,
    botId: "bot-b",
    payload: { role: "bot" as const, blocks },
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function open(chat: { botId?: string; groupId?: string }) {
  act(() => root.render(<Harness {...chat} />));
  await flush();
}

async function send(alert: Partial<ChatAlert>) {
  streams.at(-1)!.push({
    type: "alert",
    alert: {
      kind: "completion",
      title: "Scout finished",
      body: "The report is ready.",
      spaceId: "space-1",
      botId: "bot-b",
      threadId: "thread-b",
      ...alert,
    },
  });
  await flush();
}

const shown = () => FakeNotification.shown.map((n) => [n.title, n.options.body, n.options.tag]);

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", FakeNotification);
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true } as Bot;
  groups[0] = { id: "group-g" };
  streams = [];
  signals = [];
  focused = true;
  visible = true;
  openChat = vi.fn<(chat: Pick<ChatAlert, "botId" | "groupId">) => void>();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useBrowserNotifications chat alerts", () => {
  it("alerts for every kind in another chat while the app is focused", async () => {
    await open({ botId: "bot-a" });
    await send({});
    await send({ kind: "help", title: "Scout needs an answer", body: "Which repo?" });
    await send({ kind: "takeover", title: "Scout needs you on the screen", body: "Log in" });
    await send({ kind: "failure", title: "Scout failed", body: "Timed out" });
    await send({ kind: "completion", body: "Second reply." });
    expect(shown()).toEqual([
      ["Scout finished", "The report is ready.", "thread-b:completion"],
      ["Scout needs an answer", "Which repo?", "thread-b:help"],
      ["Scout needs you on the screen", "Log in", "thread-b:takeover"],
      ["Scout failed", "Timed out", "thread-b:failure"],
      ["Scout finished", "Second reply.", "thread-b:completion"],
    ]);
  });

  it("opens the alerted chat when clicked", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    await open({ botId: "bot-a" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    const [notification] = FakeNotification.shown;
    notification!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledWith(expect.objectContaining({ groupId: "group-g" }));
    expect(notification!.closed).toBe(true);
  });

  it("leaves the open chat to its own stream", async () => {
    focused = false;
    await open({ botId: "bot-b" });
    await send({ kind: "completion" });
    await send({ kind: "failure" });
    await send({ kind: "help" });
    expect(shown()).toEqual([]);
  });

  it("treats a bot's alert from a group as another chat", async () => {
    await open({ botId: "bot-b" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    expect(shown()).toHaveLength(1);
  });

  it("skips the open group's alerts", async () => {
    focused = false;
    await open({ groupId: "group-g" });
    await send({ groupId: "group-g", threadId: "thread-g" });
    expect(shown()).toEqual([]);
  });

  it("alerts for a takeover in the open chat only when the window is in the background", async () => {
    await open({ botId: "bot-b" });
    await send({ kind: "takeover" });
    expect(shown()).toEqual([]);
    visible = false;
    await send({ kind: "takeover" });
    expect(shown()).toHaveLength(1);
  });

  it("stays silent until notifications are allowed", async () => {
    FakeNotification.permission = "default";
    await open({ botId: "bot-a" });
    await send({});
    expect(shown()).toEqual([]);
  });

  it("reconnects after the stream drops", async () => {
    vi.useFakeTimers();
    await open({ botId: "bot-a" });
    streams[0]!.fail(new Error("network"));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(streams).toHaveLength(2);
    await send({});
    expect(shown()).toHaveLength(1);
  });

  it("passes roster signals on, and says when the stream that carries them drops", async () => {
    roster.changed.mockClear();
    roster.lost.mockClear();
    await open({ botId: "bot-a" });
    streams[0]!.push({ type: "roster" });
    streams[0]!.push({ type: "heartbeat" });
    await flush();
    expect(roster.changed).toHaveBeenCalledTimes(1);
    expect(roster.lost).not.toHaveBeenCalled();
    streams[0]!.fail(new Error("network"));
    await flush();
    expect(roster.lost).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([]);
  });

  it("opens the chat from its own finished-run notification", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    visible = false;
    await open({ groupId: "group-g" });
    const event = {
      id: "event-1",
      type: "thread.message.created",
      threadId: "thread-g",
      seq: 5,
      botId: "bot-b",
      payload: { role: "bot", blocks: [{ type: "text", text: "The report is ready." }] },
    } as const;
    act(() => hook.notifyBrowserForEvent(event, "thread-g", 4, true, "Scout", true, "group-g"));
    const [notification] = FakeNotification.shown;
    expect(shown()).toEqual([["Scout", "The report is ready.", "thread-g"]]);
    notification!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(openChat).toHaveBeenCalledWith({ botId: "bot-b", groupId: "group-g" });
    expect(notification!.closed).toBe(true);
  });

  it("announces a takeover once when the open chat is in the background", async () => {
    visible = false;
    await open({ botId: "bot-b" });
    const event = {
      id: "event-takeover-card",
      type: "thread.message.created" as const,
      threadId: "thread-b",
      seq: 5,
      botId: "bot-b",
      payload: {
        role: "bot" as const,
        blocks: [
          {
            kind: "computer",
            state: TAKEOVER_COMPUTER_PENDING_STATE,
            text: "Sign in to continue.",
          },
        ],
      },
    };
    act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    await send({
      kind: "takeover",
      title: "Scout needs you on the screen",
      body: "Sign in to continue.",
    });
    // Same tag, so the browser shows the alert in place of the card: one notification.
    expect(shown().map(([, , tag]) => tag)).toEqual(["thread-b:takeover", "thread-b:takeover"]);
    expect(shown().at(-1)).toEqual([
      "Scout needs you on the screen",
      "Sign in to continue.",
      "thread-b:takeover",
    ]);
  });

  it("closes the open chat's notifications when the shell unmounts", async () => {
    visible = false;
    await open({ botId: "bot-b" });
    const event = {
      id: "event-1",
      type: "run.failed",
      threadId: "thread-b",
      seq: 5,
      botId: "bot-b",
      payload: {},
    } as const;
    act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    act(() => root.unmount());
    expect(FakeNotification.shown[0]!.closed).toBe(true);
    root = createRoot(document.createElement("div"));
  });

  it("drops a notification held for permission when the shell unmounts first", async () => {
    FakeNotification.permission = "default";
    visible = false;
    await open({ botId: "bot-b" });
    const event = {
      id: "event-1",
      type: "run.failed",
      threadId: "thread-b",
      seq: 5,
      botId: "bot-b",
      payload: {},
    } as const;
    act(() => hook.notifyBrowserForEvent(event, "thread-b", 4, true, "Scout", true, undefined));
    act(() => root.unmount());
    FakeNotification.permission = "granted";
    hook.flushPendingBrowserNotifications();
    expect(shown()).toEqual([]);
    root = createRoot(document.createElement("div"));
  });

  it("stays quiet for an ordinary reply in a snoozed open chat, and still announces a question", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const earlier = new Date(Date.now() - 60 * 1000).toISOString();
    visible = false;
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    groups[0] = { id: "group-g", snoozedUntil: later };
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        reply("plain-bot", [{ kind: "text", text: "The report is ready." }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        reply("plain-group", [{ kind: "text", text: "Saturday works." }], "thread-g"),
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown()).toEqual([]);
    act(() =>
      hook.notifyBrowserForEvent(
        reply("ask-bot", [{ kind: "ask", text: "Which repo?", status: "pending" }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    act(() =>
      hook.notifyBrowserForEvent(
        reply("ask-group", [{ kind: "ask", text: "Which day?", status: "pending" }], "thread-g"),
        "thread-g",
        4,
        true,
        "Scout",
        true,
        "group-g",
      ),
    );
    expect(shown().map((row) => row[2])).toEqual(["thread-b", "thread-g"]);
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: earlier } as Bot;
    groups[0] = { id: "group-g", snoozedUntil: earlier };
    act(() =>
      hook.notifyBrowserForEvent(
        reply("woke-bot", [{ kind: "text", text: "Awake again." }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    expect(shown().map((row) => row[1])).toContain("Awake again.");
  });

  it("drops a reply queued for permission when the chat is snoozed before permission arrives", async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    FakeNotification.permission = "default";
    visible = false;
    await open({ botId: "bot-b" });
    act(() =>
      hook.notifyBrowserForEvent(
        reply("held", [{ kind: "text", text: "Still working." }]),
        "thread-b",
        4,
        true,
        "Scout",
        true,
        undefined,
      ),
    );
    bots[0] = { id: "bot-b", name: "Scout", notifyOnFinish: true, snoozedUntil: later } as Bot;
    FakeNotification.permission = "granted";
    act(() => hook.flushPendingBrowserNotifications());
    expect(shown()).toEqual([]);
  });

  it("closes the stream when the shell unmounts", async () => {
    await open({ botId: "bot-a" });
    act(() => root.unmount());
    expect(signals[0]!.aborted).toBe(true);
    root = createRoot(document.createElement("div"));
  });
});
