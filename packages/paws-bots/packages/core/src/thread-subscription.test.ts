import type { ProductEvent } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECONNECT_SPREAD_MS } from "./retry-policy.js";
import { IDLE_TIMEOUT_MS, runThreadSubscription } from "./thread-subscription.js";

const head = { threadId: "thread", cursor: 10 };
function event(seq: number): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    seq,
    type: "thread.progress",
    payload: {},
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function heartbeat(): ProductEvent {
  return { ...event(0), id: "heartbeat", type: "heartbeat" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function stream() {
  let deliver: ((result: IteratorResult<ProductEvent>) => void) | undefined;
  const events: AsyncIterable<ProductEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      };
    },
  };
  return {
    events,
    send: (value: ProductEvent) => deliver?.({ value, done: false }),
    end: () => deliver?.({ value: undefined, done: true }),
  };
}
function setup(committed: typeof head | null = head) {
  const abort = new AbortController();
  const channel = stream();
  const state = { committed };
  const callbacks = {
    signal: abort.signal,
    loadInitial: vi.fn(async () => head as typeof head | null),
    loadHead: vi.fn(async () => head as typeof head | null),
    refresh: vi.fn(async () => {}),
    currentSnapshot: () => state.committed,
    subscribe: vi.fn(async (_cursor: number, _signal: AbortSignal) => channel.events),
    beforeEvent: vi.fn(),
    applyEvent: vi.fn(),
    onEvent: vi.fn(),
    random: () => 0,
  };
  return { abort, channel, state, callbacks };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("thread subscription recovery", () => {
  it("falls back to head with backoff and replays projection after a snapshot commits", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockResolvedValueOnce(null);
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 11 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.beforeEvent).toHaveBeenCalledTimes(2);
    expect(callbacks.onEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 11]);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    replay.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(12));
    expect(callbacks.beforeEvent).toHaveBeenCalledTimes(2);
    expect(callbacks.onEvent).toHaveBeenCalledTimes(2);
    abort.abort();
    await running;
  });

  it("waits a random part of the reconnect spread before refreshing a stream the server closed", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    callbacks.random = () => 0.5;
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS / 2 - 1);
    expect(callbacks.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    abort.abort();
    await running;
  });

  it.each([
    ["bot", { threadId: "thread", cursor: 5 }],
    ["group", { threadId: "thread", cursor: 7 }],
  ])("recovers the gap behind a cached %s snapshot older than the head", async (_kind, cached) => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(cached);
    const replay = stream();
    // The fresh load failed or timed out, so only the cached snapshot is on screen.
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 10 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.subscribe).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    // Not applied onto a snapshot missing everything after its own cursor.
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.refresh).toHaveBeenCalled();
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10]);
    replay.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    abort.abort();
    await running;
  });

  it("keeps effects immediate through failed snapshot refreshes and replays all missing state", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockRejectedValue(new Error("snapshot unavailable"));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    const sequences = Array.from({ length: 128 }, (_, index) => 11 + index);
    for (const seq of sequences) {
      channel.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.beforeEvent.mock.calls.map(([item]) => item.seq)).toEqual(sequences);
    expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual(sequences);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = head;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10]);
    for (const seq of sequences) {
      replay.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual(sequences);
    expect(callbacks.beforeEvent).toHaveBeenCalledTimes(sequences.length);
    expect(callbacks.onEvent).toHaveBeenCalledTimes(sequences.length);
    expect(callbacks.onEvent.mock.calls.map(([, initial]) => initial)).toEqual(
      sequences.map(() => ({ threadId: "thread", cursor: 10 })),
    );
    abort.abort();
    await running;
  });

  it("delivers missing effects without reprojecting a snapshot ahead of the stream", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 15 };
    });
    const order: string[] = [];
    callbacks.beforeEvent.mockImplementation((item) => {
      order.push(`receipt-${item.seq}`);
    });
    callbacks.applyEvent.mockImplementation((item) => {
      order.push(`apply-${item.seq}`);
    });
    callbacks.onEvent.mockImplementation((item) => {
      order.push(`effect-${item.seq}`);
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (const seq of [11, 12]) {
      channel.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 12]);
    for (const seq of [13, 14, 15, 16]) {
      replay.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(16));
    expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);
    expect(order).toEqual([
      "receipt-11",
      "effect-11",
      "receipt-12",
      "effect-12",
      "receipt-13",
      "effect-13",
      "receipt-14",
      "effect-14",
      "receipt-15",
      "effect-15",
      "receipt-16",
      "apply-16",
      "effect-16",
    ]);
    abort.abort();
    await running;
  });

  it("preserves the effects watermark across interrupted projection replay", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    const resumed = stream();
    callbacks.subscribe
      .mockResolvedValueOnce(channel.events)
      .mockResolvedValueOnce(replay.events)
      .mockResolvedValueOnce(resumed.events);
    callbacks.refresh.mockImplementationOnce(async () => {
      state.committed = head;
    });
    callbacks.applyEvent.mockImplementation((item) => {
      state.committed = { ...head, cursor: item.seq };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (const seq of [11, 12, 13, 14]) {
      channel.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(250);
    for (const seq of [11, 12]) {
      replay.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    replay.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10, 12]);
    for (const seq of [13, 14, 15]) {
      resumed.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12, 13, 14, 15]);
    expect(callbacks.beforeEvent.mock.calls.map(([item]) => item.seq)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12, 13, 14, 15]);
    resumed.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenLastCalledWith(event(11));
    expect(callbacks.onEvent).toHaveBeenLastCalledWith(event(11), head);
    abort.abort();
    await running;
  });

  it("retains the projection floor when effects catch-up is interrupted", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    const resumed = stream();
    callbacks.subscribe
      .mockResolvedValueOnce(channel.events)
      .mockResolvedValueOnce(replay.events)
      .mockResolvedValueOnce(resumed.events);
    callbacks.refresh.mockImplementationOnce(async () => {
      state.committed = { ...head, cursor: 15 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    replay.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    replay.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 11, 12]);
    for (const seq of [13, 14, 15, 16]) {
      resumed.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(16));
    expect(callbacks.beforeEvent.mock.calls.map(([item]) => item.seq)).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);
    expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);
    abort.abort();
    await running;
  });

  it("uses a newer reconnect snapshot without replaying its projection or losing effects", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    const resumed = stream();
    callbacks.subscribe
      .mockResolvedValueOnce(channel.events)
      .mockResolvedValueOnce(replay.events)
      .mockResolvedValueOnce(resumed.events);
    callbacks.refresh
      .mockImplementationOnce(async () => {
        state.committed = head;
      })
      .mockImplementationOnce(async () => {
        state.committed = { ...head, cursor: 17 };
      });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (const seq of [11, 12, 13, 14]) {
      channel.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(250);
    replay.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    replay.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10, 11]);
    for (const seq of [12, 13, 14, 15, 16, 17, 18]) {
      resumed.send(event(seq));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 18]);
    expect(callbacks.beforeEvent.mock.calls.map(([item]) => item.seq)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    abort.abort();
    await running;
  });

  it("rebases an unresolved subscription and ignores its late transport", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const subscribing = deferred<AsyncIterable<ProductEvent>>();
    const replay = stream();
    callbacks.subscribe
      .mockReturnValueOnce(subscribing.promise)
      .mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = head;
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10]);
    expect(callbacks.subscribe.mock.calls[0]?.[1].aborted).toBe(true);
    subscribing.resolve(channel.events);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    replay.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.beforeEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith(event(11), head);
    abort.abort();
    await running;
  });

  it("wakes a pending reconnect refresh when snapshot recovery commits", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const refreshing = deferred<void>();
    const replay = stream();
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockReturnValueOnce(refreshing.promise).mockImplementation(async () => {
      state.committed = head;
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10]);
    refreshing.resolve();
    replay.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith(event(11), head);
    abort.abort();
    await running;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("finishes snapshot recovery through reconnect while its original refresh is pending", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const refreshing = deferred<void>();
    const replay = stream();
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockReturnValueOnce(refreshing.promise).mockImplementation(async () => {
      state.committed = head;
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(250);
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10]);
    replay.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    expect(callbacks.beforeEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith(event(11), head);
    abort.abort();
    await running;
    refreshing.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
  });

  it.each(["snapshot-first", "cancel-first"])(
    "does not start replay when snapshot completion races cancellation with %s",
    async (order) => {
      vi.useFakeTimers();
      const { abort, state, callbacks } = setup(null);
      const refreshed = deferred<void>();
      callbacks.refresh.mockReturnValue(refreshed.promise);
      const running = runThreadSubscription(callbacks);
      await vi.advanceTimersByTimeAsync(250);
      state.committed = head;
      if (order === "snapshot-first") {
        refreshed.resolve();
        abort.abort();
      } else {
        abort.abort();
        refreshed.resolve();
      }
      await running;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
      expect(callbacks.beforeEvent).not.toHaveBeenCalled();
      expect(callbacks.applyEvent).not.toHaveBeenCalled();
      expect(callbacks.onEvent).not.toHaveBeenCalled();
    },
  );

  it("replaces a silent stream as soon as its snapshot commits and ignores retired frames", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = head;
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe.mock.calls[0]?.[1].aborted).toBe(true);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.beforeEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    replay.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith(event(11), head);
    abort.abort();
    await running;
  });

  it.each(["snapshot-first", "frame-first"])(
    "delivers a frame racing snapshot recovery exactly once with %s",
    async (order) => {
      vi.useFakeTimers();
      const { abort, channel, state, callbacks } = setup(null);
      const replay = stream();
      const refresh = deferred<void>();
      callbacks.subscribe
        .mockResolvedValueOnce(channel.events)
        .mockResolvedValueOnce(replay.events);
      callbacks.refresh.mockReturnValue(refresh.promise);
      const running = runThreadSubscription(callbacks);
      await vi.advanceTimersByTimeAsync(0);
      channel.send(event(11));
      await vi.advanceTimersByTimeAsync(250);
      state.committed = head;
      if (order === "snapshot-first") {
        refresh.resolve();
        channel.send(event(12));
      } else {
        channel.send(event(12));
        refresh.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      for (const seq of [11, 12, 13]) {
        replay.send(event(seq));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12, 13]);
      expect(callbacks.beforeEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12, 13]);
      expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12, 13]);
      abort.abort();
      await running;
    },
  );

  it("reconnects from the highest event cursor and resets backoff after delivery", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    callbacks.subscribe.mockRejectedValueOnce(new Error("offline"));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls[0]?.[1].aborted).toBe(true);
    expect(callbacks.subscribe.mock.calls[1]?.[1].aborted).toBe(false);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10, 12]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    expect(callbacks.onEvent).toHaveBeenLastCalledWith(event(11), head);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([12, 11]);
    expect(callbacks.beforeEvent.mock.calls.map(([item]) => item.seq)).toEqual([12, 11]);
    abort.abort();
    channel.end();
    await running;
  });

  it("stops reconnecting once the server rejects the session", async () => {
    vi.useFakeTimers();
    const { callbacks } = setup();
    callbacks.subscribe.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    await expect(runThreadSubscription(callbacks)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    expect(callbacks.refresh).not.toHaveBeenCalled();
  });

  it("stops retrying the head lookup once the server rejects the session", async () => {
    vi.useFakeTimers();
    const { callbacks } = setup(null);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await expect(runThreadSubscription(callbacks)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(1);
    expect(callbacks.subscribe).not.toHaveBeenCalled();
  });

  it("stops before the head lookup when the initial load rejects the session", async () => {
    vi.useFakeTimers();
    const { callbacks } = setup();
    callbacks.loadInitial.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    await expect(runThreadSubscription(callbacks)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.loadHead).not.toHaveBeenCalled();
    expect(callbacks.subscribe).not.toHaveBeenCalled();
    expect(callbacks.refresh).not.toHaveBeenCalled();
  });

  it("stops reconnecting when its refresh rejects the session", async () => {
    vi.useFakeTimers();
    const { channel, callbacks } = setup();
    callbacks.refresh.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await expect(running).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    expect(callbacks.subscribe.mock.calls[0]?.[1].aborted).toBe(true);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["subscribe", "read", "refresh"])(
    "cancels a pending %s when snapshot recovery rejects the session",
    async (stage) => {
      vi.useFakeTimers();
      const { abort, channel, state, callbacks } = setup(null);
      const subscribed = deferred<AsyncIterable<ProductEvent>>();
      const refreshed = deferred<void>();
      callbacks.refresh.mockRejectedValue(
        Object.assign(new Error("Unauthorized"), { status: 401 }),
      );
      if (stage === "subscribe") callbacks.subscribe.mockReturnValue(subscribed.promise);
      if (stage === "refresh") callbacks.refresh.mockReturnValueOnce(refreshed.promise);
      const running = runThreadSubscription(callbacks);
      await vi.advanceTimersByTimeAsync(0);
      const transportSignal = callbacks.subscribe.mock.calls[0]?.[1];
      if (stage === "refresh") {
        channel.end();
        await vi.advanceTimersByTimeAsync(0);
        expect(callbacks.refresh).toHaveBeenCalledTimes(1);
      }
      await vi.advanceTimersByTimeAsync(250);
      await expect(running).resolves.toBeUndefined();
      expect(transportSignal?.aborted).toBe(true);
      expect(abort.signal.aborted).toBe(false);
      state.committed = head;
      subscribed.resolve(channel.events);
      refreshed.resolve();
      channel.send(event(11));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
      expect(callbacks.refresh).toHaveBeenCalledTimes(stage === "refresh" ? 2 : 1);
      expect(callbacks.beforeEvent).not.toHaveBeenCalled();
      expect(callbacks.applyEvent).not.toHaveBeenCalled();
      expect(callbacks.onEvent).not.toHaveBeenCalled();
    },
  );

  it.each([403, 404, 426])("stops reconnecting on a %i", async (status) => {
    vi.useFakeTimers();
    const { callbacks } = setup();
    callbacks.subscribe.mockRejectedValue(Object.assign(new Error("Refused"), { status }));
    await expect(runThreadSubscription(callbacks)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps reconnecting through server errors and waits as long as a 429 asks", async () => {
    vi.useFakeTimers();
    const { abort, callbacks } = setup();
    callbacks.subscribe
      .mockRejectedValueOnce(Object.assign(new Error("Unavailable"), { status: 503 }))
      .mockRejectedValueOnce(
        Object.assign(new Error("Slow down"), { status: 429, retryAfterMs: 10_000 }),
      )
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(3);
    abort.abort();
    await running;
  });

  it("cancels a reconnect delay without rejecting or starting another request", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps receipt handling before applying events and effects afterward", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const order: string[] = [];
    callbacks.applyEvent.mockImplementation(() => {
      order.push("apply");
    });
    callbacks.onEvent.mockImplementation(() => {
      order.push("effect");
    });
    const running = runThreadSubscription({
      ...callbacks,
      beforeEvent: () => {
        order.push("receipt");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["receipt", "apply", "effect"]);
    abort.abort();
    channel.end();
    await running;
  });

  it("does not refresh or replay after cancellation during snapshot delay", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup(null);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await running;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.refresh).not.toHaveBeenCalled();
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
  });

  it("cancels an unresolved initial load and ignores its late response", async () => {
    const { abort, callbacks } = setup();
    const initial = deferred<typeof head>();
    callbacks.loadInitial.mockReturnValue(initial.promise);
    const running = runThreadSubscription(callbacks);
    abort.abort();
    await running;
    initial.resolve(head);
    await Promise.resolve();
    expect(callbacks.subscribe).not.toHaveBeenCalled();
    expect(callbacks.loadHead).not.toHaveBeenCalled();
  });

  it("cancels an unresolved head load and ignores its late response", async () => {
    vi.useFakeTimers();
    const { abort, callbacks } = setup();
    const loaded = deferred<typeof head>();
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockReturnValue(loaded.promise);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await running;
    loaded.resolve(head);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(1);
    expect(callbacks.subscribe).not.toHaveBeenCalled();
  });

  it("cancels head backoff without issuing another request", async () => {
    vi.useFakeTimers();
    const { abort, callbacks } = setup();
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockResolvedValue(null);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await running;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(1);
    expect(callbacks.subscribe).not.toHaveBeenCalled();
  });

  it("stops snapshot retries while the caller-owned refresh request remains pending", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const refreshed = deferred<void>();
    callbacks.refresh.mockReturnValue(refreshed.promise);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    abort.abort();
    await running;
    state.committed = head;
    refreshed.resolve();
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    expect(callbacks.beforeEvent).not.toHaveBeenCalled();
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
  });

  it("cancels an unresolved reconnect refresh without opening another stream", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const refreshed = deferred<void>();
    callbacks.refresh.mockReturnValue(refreshed.promise);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    abort.abort();
    await running;
    refreshed.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
  });

  it.each(["initial", "replay"])("cancels an unresolved %s subscription", async (stage) => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(stage === "replay" ? null : head);
    const subscribed = deferred<AsyncIterable<ProductEvent>>();
    if (stage === "replay") {
      callbacks.subscribe.mockResolvedValueOnce(channel.events);
      callbacks.refresh.mockImplementation(async () => {
        state.committed = head;
      });
    }
    callbacks.subscribe.mockReturnValue(subscribed.promise);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(stage === "replay" ? 250 : 0);
    const requests = stage === "replay" ? 2 : 1;
    expect(callbacks.subscribe).toHaveBeenCalledTimes(requests);
    const transportSignal = callbacks.subscribe.mock.calls.at(-1)?.[1];
    abort.abort();
    await running;
    expect(transportSignal?.aborted).toBe(true);
    subscribed.resolve(stream().events);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(requests);
    expect(callbacks.beforeEvent).not.toHaveBeenCalled();
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
  });

  it("cancels a pending replay read without waiting for a frame", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const replay = stream();
    callbacks.subscribe.mockResolvedValueOnce(channel.events).mockResolvedValueOnce(replay.events);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = head;
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    abort.abort();
    await running;
    channel.send(event(11));
    replay.send(event(11));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    expect(callbacks.beforeEvent).not.toHaveBeenCalled();
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
  });

  it("aborts the current transport and ignores a late frame after switching away", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    const transportSignal = callbacks.subscribe.mock.calls[0]?.[1];
    abort.abort();
    expect(transportSignal?.aborted).toBe(true);
    await running;
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    expect(callbacks.refresh).not.toHaveBeenCalled();
  });

  it("skips displaced-snapshot events while retaining effects and subsequent live updates", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    state.committed = { threadId: "replacement-thread", cursor: 0 };
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).toHaveBeenCalledWith(event(11), head);
    state.committed = head;
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(12));
    expect(callbacks.refresh).not.toHaveBeenCalled();
    abort.abort();
    channel.end();
    await running;
  });

  it("swallows heartbeats without applying them or advancing the cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    abort.abort();
    channel.end();
    await running;
  });

  it("abandons a silent stream and resubscribes from the same cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 11]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12]);
    abort.abort();
    channel.end();
    await running;
  });

  it("keeps a heartbeat alive as liveness so the idle timer never fires", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1_000);
      channel.send(heartbeat());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    abort.abort();
    channel.end();
    await running;
  });

  it("aborts the silent transport before refreshing and opening its replacement", async () => {
    vi.useFakeTimers();
    const { abort, callbacks } = setup();
    const signals: AbortSignal[] = [];
    const abortedAtRefresh: boolean[] = [];
    let openTransports = 0;
    callbacks.subscribe.mockImplementation(async (_cursor, transportSignal) => {
      // An async generator's return queues behind its pending read. Only aborting
      // the request releases the socket, even when return has already been called.
      const signal = transportSignal ?? abort.signal;
      signals.push(signal);
      openTransports += 1;
      return (async function* () {
        try {
          yield heartbeat();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
          yield event(11);
        } finally {
          openTransports -= 1;
        }
      })();
    });
    callbacks.refresh.mockImplementation(async () => {
      abortedAtRefresh.push(signals.at(-1)?.aborted === true);
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 250);
      expect(signals[attempt]?.aborted).toBe(true);
      expect(openTransports).toBe(1);
      expect(abort.signal.aborted).toBe(false);
    }
    expect(new Set(signals).size).toBe(9);
    expect(abortedAtRefresh).toEqual(Array(8).fill(true));
    abort.abort();
    await running;
    expect(openTransports).toBe(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
  });

  it("forwards cancellation without AbortSignal.any and releases parent listeners", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    vi.stubGlobal("AbortSignal", { any: undefined });
    const add = vi.spyOn(abort.signal, "addEventListener");
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const running = runThreadSubscription(callbacks);
    void running.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe.mock.calls[0]?.[1].aborted).toBe(true);
    const currentSignal = callbacks.subscribe.mock.calls[1]?.[1];
    const reason = new Error("switched thread");
    abort.abort(reason);
    expect(currentSignal?.aborted).toBe(true);
    expect(currentSignal?.reason).toBe(reason);
    await expect(running).resolves.toBeUndefined();
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
  });
});
