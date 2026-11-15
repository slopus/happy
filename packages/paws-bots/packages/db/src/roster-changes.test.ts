import { describe, expect, it, vi } from "vitest";
import type { RosterScope } from "./roster-changes.js";
import { followRosterChanges, publishRosterChange } from "./roster-changes.js";

function fakeFanout() {
  const subscribers = new Map<string, Set<(payload: string) => void>>();
  const published: string[] = [];
  return {
    published,
    topics: () => [...subscribers.keys()].sort(),
    publish: async (topic: string, payload: string) => {
      published.push(topic);
      for (const subscriber of subscribers.get(topic) ?? []) subscriber(payload);
    },
    subscribe: async (topic: string, callback: (payload: string) => void) => {
      const set = subscribers.get(topic) ?? new Set();
      set.add(callback);
      subscribers.set(topic, set);
      return async () => {
        set.delete(callback);
        if (set.size === 0) subscribers.delete(topic);
      };
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("followRosterChanges", () => {
  it("signals on open, then on chat events and roster changes, re-reading what it watches", async () => {
    const fanout = fakeFanout();
    let scope: RosterScope = { spaceIds: ["space-1"], threadIds: ["thread-1"] };
    const iterator = followRosterChanges(
      fanout as never,
      "user-1",
      async () => scope,
      undefined,
      0,
    );
    expect((await iterator.next()).done).toBe(false);
    expect(fanout.topics()).toEqual([
      "roster-space:space-1",
      "roster-user:user-1",
      "thread:thread-1",
    ]);

    let next = iterator.next();
    await tick();
    scope = { spaceIds: ["space-1"], threadIds: ["thread-1", "thread-2"] };
    await fanout.publish("thread:thread-1", JSON.stringify({ cursor: 4 }));
    expect((await next).done).toBe(false);
    expect(fanout.topics()).toContain("thread:thread-2");

    next = iterator.next();
    await tick();
    await publishRosterChange(fanout as never, { spaceIds: ["space-1"] });
    expect((await next).done).toBe(false);

    next = iterator.next();
    await tick();
    await publishRosterChange(fanout as never, { userIds: ["user-1"] });
    expect((await next).done).toBe(false);
    await iterator.return(undefined);
    expect(fanout.topics()).toEqual([]);
  });

  it("re-reads what it watches while idle, without signalling", async () => {
    vi.useFakeTimers();
    try {
      const fanout = fakeFanout();
      let scope: RosterScope = { spaceIds: ["space-1"], threadIds: ["thread-1"] };
      const controller = new AbortController();
      const iterator = followRosterChanges(
        fanout as never,
        "user-1",
        async () => scope,
        controller.signal,
        0,
      );
      await iterator.next();
      let signalled = false;
      const next = iterator.next().then(() => {
        signalled = true;
      });
      scope = { spaceIds: ["space-1"], threadIds: ["thread-1", "thread-2"] };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fanout.topics()).toContain("thread:thread-2");
      expect(signalled).toBe(false);
      controller.abort();
      await next;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores other people's and other Spaces' changes", async () => {
    const fanout = fakeFanout();
    const scope = { spaceIds: ["space-1"], threadIds: ["thread-1"] };
    const controller = new AbortController();
    const iterator = followRosterChanges(
      fanout as never,
      "user-1",
      async () => scope,
      controller.signal,
      0,
    );
    await iterator.next();
    const next = iterator.next();
    await tick();
    await publishRosterChange(fanout as never, { spaceIds: ["space-2"], userIds: ["user-2"] });
    await fanout.publish("thread:thread-9", "");
    await tick();
    controller.abort();
    expect((await next).done).toBe(true);
  });

  it("turns a burst of chat events into one signal per spacing", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const fanout = fakeFanout();
      const scope = { spaceIds: [], threadIds: ["thread-1"] };
      const iterator = followRosterChanges(
        fanout as never,
        "user-1",
        async () => scope,
        controller.signal,
        3_000,
      );
      await iterator.next();
      let signals = 0;
      const reading = (async () => {
        while (!(await iterator.next()).done) signals += 1;
      })();
      for (let i = 0; i < 20; i++) {
        await fanout.publish("thread:thread-1", "");
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(signals).toBe(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(signals).toBe(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signals).toBe(2);
      controller.abort();
      await reading;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("publishRosterChange", () => {
  it("signals each Space and person, and does nothing without a fanout", async () => {
    const fanout = fakeFanout();
    await publishRosterChange(fanout as never, { spaceIds: ["space-1"], userIds: ["user-2"] });
    expect(fanout.published).toEqual(["roster-space:space-1", "roster-user:user-2"]);
    await expect(
      publishRosterChange(undefined, { spaceIds: ["space-1"] }),
    ).resolves.toBeUndefined();
  });
});
