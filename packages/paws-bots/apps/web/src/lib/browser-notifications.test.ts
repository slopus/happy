import { TAKEOVER_COMPUTER_PENDING_STATE } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserNotificationApi,
  BrowserNotificationContext,
} from "./browser-notifications.js";
import {
  browserNotificationMessage,
  deliverBrowserNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "./browser-notifications.js";
import { i18n } from "./i18n.js";

function event(
  overrides: Partial<{
    type:
      | "thread.message.created"
      | "run.completed"
      | "run.failed"
      | "run.cancelled"
      | "run.started";
    threadId: string;
    id: string;
    runId: string;
    seq: number;
    payload: Record<string, unknown>;
  }> = {},
) {
  return {
    type: "thread.message.created" as const,
    id: "event-1",
    threadId: "thread-1",
    runId: "run-1",
    seq: 8,
    payload: { role: "bot", blocks: [{ kind: "text", text: "The pool is balanced." }] },
    ...overrides,
  };
}

function context(overrides: Partial<BrowserNotificationContext> = {}): BrowserNotificationContext {
  return {
    subscribedThreadId: "thread-1",
    initialCursor: 7,
    streamReady: true,
    pageVisible: false,
    windowFocused: false,
    permission: "granted",
    notifiedEventIds: new Set(),
    ...overrides,
  };
}

describe("browser notifications", () => {
  beforeEach(() => {
    i18n.load("en", {
      "{name} failed": "Chief failed",
      "{name} finished": "Chief finished",
      "{name} stopped": "Chief stopped",
      "Failed.": "Failed.",
      "Stopped.": "Stopped.",
      "Finished.": "Finished.",
    });
    i18n.activate("en");
  });

  it("only accepts a new bot message for the hidden or unfocused subscribed thread", () => {
    expect(shouldNotifyBrowser(event(), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ type: "run.started" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ type: "run.failed" }), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ type: "run.cancelled" }), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ payload: { role: "user", blocks: [] } }), context())).toBe(
      false,
    );
    expect(shouldNotifyBrowser(event({ type: "run.completed" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ threadId: "other-thread" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ seq: 7 }), context())).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ pageVisible: true, windowFocused: false }))).toBe(
      true,
    );
    expect(shouldNotifyBrowser(event(), context({ pageVisible: false, windowFocused: true }))).toBe(
      true,
    );
    expect(shouldNotifyBrowser(event(), context({ streamReady: false }))).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ pageVisible: true, windowFocused: true }))).toBe(
      false,
    );
    expect(shouldNotifyBrowser(event(), context({ permission: "default" }))).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ notifiedEventIds: new Set(["event-1"]) }))).toBe(
      false,
    );
  });

  it("accepts another member's message in a shared chat, never the viewer's own", () => {
    const by = (id: string) =>
      event({
        payload: {
          role: "user",
          author: { id, name: "Ada Owner" },
          blocks: [{ kind: "text", text: "Saturday works" }],
        },
      });
    expect(shouldNotifyBrowser(by("user-a"), context({ meId: "user-b" }))).toBe(true);
    expect(shouldNotifyBrowser(by("user-b"), context({ meId: "user-b" }))).toBe(false);
    // Like its push: not a spoken call turn, nor a file sent with no text.
    const spoken = by("user-a");
    spoken.payload = { ...spoken.payload, callId: "call-1" };
    expect(shouldNotifyBrowser(spoken, context({ meId: "user-b" }))).toBe(false);
    const fileOnly = by("user-a");
    fileOnly.payload = { ...fileOnly.payload, blocks: [{ kind: "file", name: "plan.pdf" }] };
    expect(shouldNotifyBrowser(fileOnly, context({ meId: "user-b" }))).toBe(false);
    expect(browserNotificationMessage(by("user-a"), "Chief")).toEqual({
      title: "Chief",
      body: "Ada Owner: Saturday works",
    });
  });

  it("tags a card that only asks for the computer like the takeover alert", () => {
    const card = {
      kind: "computer",
      state: TAKEOVER_COMPUTER_PENDING_STATE,
      text: "Sign in to continue.",
    };
    const tagFor = (blocks: unknown[], id: string) => {
      const show = vi.fn();
      deliverBrowserNotification(event({ id, payload: { role: "bot", blocks } }), "Chief", {
        enabled: true,
        pageVisible: false,
        windowFocused: false,
        permission: "granted",
        notifiedEventIds: new Set(),
        show,
      });
      return show.mock.calls[0]?.[2];
    };
    expect(tagFor([card], "event-card")).toBe("thread-1:takeover");
    expect(tagFor([card, { kind: "text", text: "Also this." }], "event-mixed")).toBe("thread-1");
    expect(tagFor([{ kind: "computer", state: "Done", text: "Back." }], "event-done")).toBe(
      "thread-1",
    );
  });

  it("puts the bot message in the native notification", () => {
    expect(browserNotificationMessage(event(), "Chief")).toEqual({
      title: "Chief",
      body: "The pool is balanced.",
    });
    expect(
      browserNotificationMessage(
        event({
          payload: {
            role: "bot",
            blocks: [{ kind: "text", text: "| Pool | Total |\n| --- | --- |\n| main | **42** |" }],
          },
        }),
        "Chief",
      ),
    ).toEqual({ title: "Chief", body: "Pool, Total main, 42" });
    expect(browserNotificationMessage(event({ type: "run.failed" }), "Chief")).toEqual({
      title: "Chief failed",
      body: "Failed.",
    });
    expect(browserNotificationMessage(event({ type: "run.cancelled" }), "Chief")).toEqual({
      title: "Chief stopped",
      body: "Stopped.",
    });
  });

  it("dedupes a replay but delivers another message from the same run", () => {
    const notifiedEventIds = new Set<string>();
    const show = vi.fn().mockImplementationOnce(() => {
      throw new Error("notification construction failed");
    });
    const delivery = (permission: "default" | "granted", nextEvent = event()) =>
      deliverBrowserNotification(nextEvent, "Chief", {
        enabled: true,
        pageVisible: false,
        windowFocused: false,
        permission,
        notifiedEventIds,
        show,
      });

    expect(delivery("default")).toBe("pending");
    expect(delivery("granted")).toBe("pending");
    expect(notifiedEventIds).toEqual(new Set());
    expect(delivery("granted")).toBe("delivered");
    expect(notifiedEventIds).toEqual(new Set(["event-1"]));
    expect(show).toHaveBeenLastCalledWith("Chief", "The pool is balanced.", "thread-1");
    expect(delivery("granted")).toBe("discarded");
    expect(delivery("granted", event({ id: "event-2" }))).toBe("delivered");
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("allows a later send gesture to retry a dismissed permission prompt", async () => {
    let resolvePermission: ((permission: "default") => void) | undefined;
    const requestPermission = vi.fn(
      () =>
        new Promise<"default">((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const api: BrowserNotificationApi = { permission: "default", requestPermission };

    requestBrowserNotificationPermission(api);
    requestBrowserNotificationPermission(api);
    expect(requestPermission).toHaveBeenCalledTimes(1);

    resolvePermission?.("default");
    await Promise.resolve();
    requestBrowserNotificationPermission(api);
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });
});

it("uses a readable fallback for opaque notification names", () => {
  expect(browserNotificationMessage(event(), "__TestTok1__").title).toBe("Bot");
});
