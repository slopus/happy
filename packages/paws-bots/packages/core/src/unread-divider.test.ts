import { describe, expect, it, vi } from "vitest";
import {
  canMarkMessageUnread,
  createChatQueues,
  createSerialQueue,
  settleReadBoundary,
  unreadDividerMessageId,
  voiceChatHoldsMessage,
} from "./unread-divider.js";
import { groupVoiceChats } from "./voice-chat-groups.js";

const thread = [
  { id: "m0", role: "bot", seq: 0 },
  { id: "m1", role: "user", seq: 1 },
  { id: "m2", role: "user", seq: 2 },
  { id: "m3", role: "bot", seq: 3 },
  { id: "m4", role: "bot", seq: 4 },
];

describe("unreadDividerMessageId", () => {
  it("sits above the first bot message after the read cursor, skipping the user's own", () => {
    expect(unreadDividerMessageId(thread, 0, null)).toBe("m3");
    expect(unreadDividerMessageId(thread, 3, null)).toBe("m4");
  });

  it("shows nothing when nothing was unread or only the user wrote since", () => {
    expect(unreadDividerMessageId(thread, null, null)).toBeNull();
    expect(unreadDividerMessageId(thread, 4, null)).toBeNull();
    expect(unreadDividerMessageId(thread.slice(0, 3), 0, null)).toBeNull();
  });

  it("starts at another member's message in a shared chat, never the viewer's own", () => {
    const shared = [
      { id: "m0", role: "bot", seq: 0 },
      { id: "m1", role: "user", seq: 1, author: { id: "user-b", name: "Bea" } },
      { id: "m2", role: "user", seq: 2, author: { id: "user-a", name: "Ada" } },
      { id: "m3", role: "bot", seq: 3 },
    ];
    expect(unreadDividerMessageId(shared, 0, null, "user-a")).toBe("m1");
    expect(unreadDividerMessageId(shared, 0, null, "user-b")).toBe("m2");
    expect(unreadDividerMessageId(shared, 1, null, "user-b")).toBe("m2");
    expect(unreadDividerMessageId(shared, 1, null, "user-a")).toBe("m3");
  });

  it("shows nothing above the start of a chat never read", () => {
    expect(unreadDividerMessageId(thread, -1, null)).toBeNull();
    expect(unreadDividerMessageId(thread.slice(1), -1, null)).toBe("m3");
  });

  it("ignores rows without a seq, such as live progress", () => {
    expect(unreadDividerMessageId([{ id: "progress:run", role: "bot" }, ...thread], 2, null)).toBe(
      "m3",
    );
  });

  it("waits while an unloaded older page could hold the first unread message", () => {
    const latestPage = thread.slice(3);
    expect(unreadDividerMessageId(latestPage, 0, 3)).toBeNull();
    expect(unreadDividerMessageId(latestPage, 2, 3)).toBe("m3");
    expect(unreadDividerMessageId(latestPage, 2, null)).toBeNull();
  });

  it("doesn't wait when the loaded page starts with a hidden message right after the cursor", () => {
    // The page starts at seq 50, a hidden tool message; only the reply at 51 is visible.
    expect(unreadDividerMessageId([{ id: "m51", role: "bot", seq: 51 }], 49, 50)).toBe("m51");
  });
});

describe("voiceChatHoldsMessage", () => {
  it("finds the first unread reply inside a voice card that starts with the user's turn", () => {
    const messages = [
      { id: "m1", role: "user", seq: 1, callId: "call-1", runId: "run-1", blocks: [] },
      { id: "m2", role: "bot", seq: 2, runId: "run-1", blocks: [] },
    ];
    const [card] = groupVoiceChats(messages);
    const dividerId = unreadDividerMessageId(messages, 1, null);
    expect(card?.kind).toBe("voiceChat");
    expect(card?.kind === "voiceChat" && card.messages[0]?.id === dividerId).toBe(false);
    expect(card?.kind === "voiceChat" && voiceChatHoldsMessage(card, dividerId)).toBe(true);
    expect(card?.kind === "voiceChat" && voiceChatHoldsMessage(card, null)).toBe(false);
  });
});

describe("settleReadBoundary", () => {
  it("keeps the first answer of the open visit", () => {
    const first = settleReadBoundary(null, 1, { visit: 1, seq: 3 });
    expect(first).toEqual({ visit: 1, seq: 3 });
    expect(settleReadBoundary(first, 1, { visit: 1, seq: null })).toBe(first);
  });

  it("drops a late answer from a chat the user has left", () => {
    // Open A (visit 1), switch to B (visit 2), B answers, then A's slow answer arrives.
    const b = settleReadBoundary(null, 2, { visit: 2, seq: 7 });
    expect(settleReadBoundary(b, 2, { visit: 1, seq: 3 })).toEqual({ visit: 2, seq: 7 });
    expect(settleReadBoundary(null, 2, { visit: 1, seq: 3 })).toBeNull();
  });
});

describe("createSerialQueue", () => {
  it("answers in the order tasks were queued, even when a later one is faster", async () => {
    const inOrder = createSerialQueue();
    const answered: string[] = [];
    let releaseOpening!: () => void;
    const opening = inOrder(
      () => new Promise<string>((resolve) => (releaseOpening = () => resolve("opening"))),
    ).then((value) => answered.push(value));
    const live = inOrder(async () => "live").then((value) => answered.push(value));
    await Promise.resolve();
    expect(answered).toEqual([]);
    releaseOpening();
    await Promise.all([opening, live]);
    expect(answered).toEqual(["opening", "live"]);
  });

  it("keeps going after a task fails", async () => {
    const inOrder = createSerialQueue();
    const failed = inOrder(async () => {
      throw new Error("offline");
    });
    await expect(failed).rejects.toThrow("offline");
    await expect(inOrder(async () => 4)).resolves.toBe(4);
  });

  it("moves on when a task hangs past the wait cap", async () => {
    const inOrder = createSerialQueue(20);
    void inOrder(() => new Promise<never>(() => undefined));
    await expect(inOrder(async () => "next")).resolves.toBe("next");
  });

  it("gives each hanging task its own wait cap after it starts", async () => {
    vi.useFakeTimers();
    try {
      const inOrder = createSerialQueue();
      const started: number[] = [];
      for (const id of [1, 2]) {
        void inOrder(() => {
          started.push(id);
          return new Promise<never>(() => undefined);
        });
      }
      const last = inOrder(async () => started.push(3));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(started).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(started).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(1);
      await last;
      expect(started).toEqual([1, 2, 3]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createChatQueues", () => {
  it("keeps one chat's reads in order without holding up another chat", async () => {
    const inOrder = createChatQueues();
    const answered: string[] = [];
    let releaseA!: () => void;
    const openingA = inOrder(
      "bot:a",
      () => new Promise<string>((resolve) => (releaseA = () => resolve("a1"))),
    ).then((value) => answered.push(value));
    const liveA = inOrder("bot:a", async () => "a2").then((value) => answered.push(value));
    await inOrder("bot:b", async () => "b1").then((value) => answered.push(value));
    expect(answered).toEqual(["b1"]);
    releaseA();
    await Promise.all([openingA, liveA]);
    expect(answered).toEqual(["b1", "a1", "a2"]);
  });
});

describe("canMarkMessageUnread", () => {
  it("offers any sent message, the user's own included, but not live rows", () => {
    expect(canMarkMessageUnread({ id: "message-1" })).toBe(true);
    expect(canMarkMessageUnread({ id: "progress:run-1" })).toBe(false);
    expect(canMarkMessageUnread({ id: "subagent:agent-1" })).toBe(false);
    // The divider then starts at the first reply after the user's own message.
    expect(
      unreadDividerMessageId(
        [
          { id: "m1", role: "user", seq: 1 },
          { id: "m2", role: "bot", seq: 2 },
        ],
        0,
        null,
      ),
    ).toBe("m2");
  });
});

describe("marking unread through a chat's read queue", () => {
  it("keeps a later read behind mark-unread after an earlier read times out", async () => {
    vi.useFakeTimers();
    try {
      const inOrder = createChatQueues();
      const started: string[] = [];
      let unread = false;
      let finishMarkUnread!: () => void;
      void inOrder("bot:a", () => {
        started.push("opening");
        return new Promise<never>(() => undefined);
      });
      const mark = inOrder("bot:a", () => {
        started.push("mark-unread");
        return new Promise<void>((resolve) => {
          finishMarkUnread = () => {
            unread = true;
            resolve();
          };
        });
      });
      const read = inOrder("bot:a", async () => {
        started.push("read");
        unread = false;
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(started).toEqual(["opening", "mark-unread"]);
      finishMarkUnread();
      await Promise.all([mark, read]);
      expect(started).toEqual(["opening", "mark-unread", "read"]);
      expect(unread).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lands after a read already in flight, and a read still queued skips while held", async () => {
    const inOrder = createChatQueues();
    let unread = false;
    let held = false;
    let finishRead!: () => void;
    // An automatic read is already on its way when the user marks a message unread.
    const inFlight = inOrder(
      "bot:a",
      () =>
        new Promise<void>((resolve) => {
          finishRead = () => {
            unread = false;
            resolve();
          };
        }),
    );
    // Another automatic read was queued; it checks the hold when its turn comes.
    const queued = inOrder("bot:a", async () => {
      if (!held) unread = false;
    });
    held = true;
    const mark = inOrder("bot:a", async () => {
      unread = true;
    });
    // The queue starts the read on the next tick; finish it once it has started.
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishRead();
    await Promise.all([inFlight, queued, mark]);
    expect(unread).toBe(true);
  });
});
