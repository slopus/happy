import type { ChatAlert } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { createChatAlerts } from "./chat-alerts.js";

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

const alert: ChatAlert = {
  kind: "help",
  title: "Scout needs an answer",
  body: "Which repo?",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
};

describe("createChatAlerts", () => {
  it("delivers only the followed user's alerts, skipping malformed ones", async () => {
    const fanout = fakeFanout();
    const alerts = createChatAlerts(fanout as never);
    const iterator = alerts.follow("user-1", "space-1");
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await alerts.publish("user-2", { ...alert, body: "Not yours" });
    await alerts.publish("user-1", { ...alert, spaceId: "space-2", body: "Other space" });
    await fanout.publish("chat-alerts:user-1", "{");
    await fanout.publish("chat-alerts:user-1", JSON.stringify({ kind: "help" }));
    await alerts.publish("user-1", alert);
    expect((await pending).value).toEqual(alert);
    await iterator.return(undefined);
  });

  it("keeps only the newest alerts for a stream that stops reading", async () => {
    const fanout = fakeFanout();
    const alerts = createChatAlerts(fanout as never);
    const iterator = alerts.follow("user-1", "space-1");
    const first = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 30; i++) await alerts.publish("user-1", { ...alert, body: `Alert ${i}` });
    expect((await first).value.body).toBe("Alert 0");
    expect((await iterator.next()).value.body).toBe("Alert 10");
    await iterator.return(undefined);
  });

  it("ends the stream on abort", async () => {
    const controller = new AbortController();
    const iterator = createChatAlerts(fakeFanout() as never).follow(
      "user-1",
      "space-1",
      controller.signal,
    );
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect((await pending).done).toBe(true);
  });

  it("ends the stream with the error when the subscription fails, so the app reconnects", async () => {
    const fanout = { ...fakeFanout(), subscribe: () => Promise.reject(new Error("listen failed")) };
    const iterator = createChatAlerts(fanout as never).follow("user-1", "space-1");
    await expect(iterator.next()).rejects.toThrow("listen failed");
  });

  it("does not throw without a realtime fanout", async () => {
    await expect(createChatAlerts().publish("user-1", alert)).resolves.toBeUndefined();
  });
});
