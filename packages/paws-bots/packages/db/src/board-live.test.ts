import { describe, expect, it } from "vitest";
import { createBoardEvents } from "./board-live.js";

function fakeFanout() {
  const subscribers = new Map<string, Set<(payload: string) => void>>();
  return {
    publish: async (topic: string, payload: string) => {
      for (const subscriber of subscribers.get(topic) ?? []) subscriber(payload);
    },
    subscribe: (topic: string, callback: (payload: string) => void) => {
      const set = subscribers.get(topic) ?? new Set();
      set.add(callback);
      subscribers.set(topic, set);
      return Promise.resolve(async () => {
        set.delete(callback);
      });
    },
  };
}

describe("createBoardEvents", () => {
  it("follows only the requested space and yields the change", async () => {
    const fanout = fakeFanout();
    const events = createBoardEvents(fanout as never);
    const iterator = events.follow("space-1")[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await events.notify("space-2", { ticketId: "other" });
    await events.notify("space-1", { boardId: "board-1", ticketId: "ticket-1" });

    const first = await pending;
    expect(first.value).toMatchObject({
      spaceId: "space-1",
      boardId: "board-1",
      ticketId: "ticket-1",
    });
    await iterator.return?.(undefined);
  });

  it("does not throw without a realtime fanout", async () => {
    const events = createBoardEvents();
    await expect(events.notify("space-1")).resolves.toBeUndefined();
  });
});
